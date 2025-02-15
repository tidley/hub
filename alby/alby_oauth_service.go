package alby

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	decodepay "github.com/nbd-wtf/ln-decodepay"
	"github.com/sirupsen/logrus"
	"golang.org/x/oauth2"
	"gorm.io/gorm"

	"github.com/getAlby/hub/config"
	"github.com/getAlby/hub/constants"
	"github.com/getAlby/hub/db"
	"github.com/getAlby/hub/events"
	"github.com/getAlby/hub/lnclient"
	"github.com/getAlby/hub/logger"
	"github.com/getAlby/hub/nip47/permissions"
	"github.com/getAlby/hub/service/keys"
	"github.com/getAlby/hub/transactions"
	"github.com/getAlby/hub/utils"
	"github.com/getAlby/hub/version"
)

type albyOAuthService struct {
	cfg            config.Config
	oauthConf      *oauth2.Config
	db             *gorm.DB
	keys           keys.Keys
	eventPublisher events.EventPublisher
}

const (
	accessTokenKey       = "AlbyOAuthAccessToken"
	accessTokenExpiryKey = "AlbyOAuthAccessTokenExpiry"
	refreshTokenKey      = "AlbyOAuthRefreshToken"
	userIdentifierKey    = "AlbyUserIdentifier"
	lightningAddressKey  = "AlbyLightningAddress"
)

const ALBY_ACCOUNT_APP_NAME = "getalby.com"

func NewAlbyOAuthService(db *gorm.DB, cfg config.Config, keys keys.Keys, eventPublisher events.EventPublisher) *albyOAuthService {
	conf := &oauth2.Config{
		ClientID:     cfg.GetEnv().AlbyClientId,
		ClientSecret: cfg.GetEnv().AlbyClientSecret,
		Scopes:       []string{"account:read", "balance:read", "payments:send"},
		Endpoint: oauth2.Endpoint{
			TokenURL:  cfg.GetEnv().AlbyAPIURL + "/oauth/token",
			AuthURL:   cfg.GetEnv().AlbyOAuthAuthUrl,
			AuthStyle: 2, // use HTTP Basic Authorization https://pkg.go.dev/golang.org/x/oauth2#AuthStyle
		},
	}

	if cfg.GetEnv().IsDefaultClientId() {
		conf.RedirectURL = "https://getalby.com/hub/callback"
	} else {
		conf.RedirectURL = cfg.GetEnv().BaseUrl + "/api/alby/callback"
	}

	albyOAuthSvc := &albyOAuthService{
		oauthConf:      conf,
		cfg:            cfg,
		db:             db,
		keys:           keys,
		eventPublisher: eventPublisher,
	}
	return albyOAuthSvc
}

func (svc *albyOAuthService) CallbackHandler(ctx context.Context, code string, lnClient lnclient.LNClient) error {
	token, err := svc.oauthConf.Exchange(ctx, code)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to exchange token")
		return err
	}
	svc.saveToken(token)

	me, err := svc.GetMe(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user me")
		// remove token so user can retry
		svc.cfg.SetUpdate(accessTokenKey, "", "")
		return err
	}

	existingUserIdentifier, err := svc.GetUserIdentifier()
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to get alby user identifier")
		return err
	}

	// save the user's alby account ID on first time login
	if existingUserIdentifier == "" {
		svc.cfg.SetUpdate(userIdentifierKey, me.Identifier, "")

		if svc.cfg.GetEnv().AutoLinkAlbyAccount {
			// link account on first login
			err := svc.LinkAccount(ctx, lnClient, 1_000_000, constants.BUDGET_RENEWAL_MONTHLY)
			if err != nil {
				logger.Logger.WithError(err).Error("Failed to link account on first auth callback")
			}
		}

	} else if me.Identifier != existingUserIdentifier {
		// remove token so user can retry with correct account
		svc.cfg.SetUpdate(accessTokenKey, "", "")
		return errors.New("Alby Hub is connected to a different alby account. Please log out of your Alby Account at getalby.com and try again.")
	}

	return nil
}

func (svc *albyOAuthService) GetUserIdentifier() (string, error) {
	userIdentifier, err := svc.cfg.Get(userIdentifierKey, "")
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user identifier from user configs")
		return "", err
	}
	return userIdentifier, nil
}

func (svc *albyOAuthService) GetLightningAddress() (string, error) {
	lightningAddress, err := svc.cfg.Get(lightningAddressKey, "")
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch lightning address from user configs")
		return "", err
	}
	return lightningAddress, nil
}

func (svc *albyOAuthService) IsConnected(ctx context.Context) bool {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to check fetch token")
	}
	return token != nil
}

func (svc *albyOAuthService) saveToken(token *oauth2.Token) {
	svc.cfg.SetUpdate(accessTokenExpiryKey, strconv.FormatInt(token.Expiry.Unix(), 10), "")
	svc.cfg.SetUpdate(accessTokenKey, token.AccessToken, "")
	svc.cfg.SetUpdate(refreshTokenKey, token.RefreshToken, "")
}

var tokenMutex sync.Mutex

func (svc *albyOAuthService) fetchUserToken(ctx context.Context) (*oauth2.Token, error) {
	tokenMutex.Lock()
	defer tokenMutex.Unlock()
	accessToken, err := svc.cfg.Get(accessTokenKey, "")
	if err != nil {
		return nil, err
	}

	if accessToken == "" {
		return nil, nil
	}

	expiry, err := svc.cfg.Get(accessTokenExpiryKey, "")
	if err != nil {
		return nil, err
	}

	if expiry == "" {
		return nil, nil
	}

	expiry64, err := strconv.ParseInt(expiry, 10, 64)
	if err != nil {
		return nil, err
	}
	refreshToken, err := svc.cfg.Get(refreshTokenKey, "")
	if err != nil {
		return nil, err
	}

	if refreshToken == "" {
		return nil, nil
	}

	currentToken := &oauth2.Token{
		AccessToken:  accessToken,
		Expiry:       time.Unix(expiry64, 0),
		RefreshToken: refreshToken,
	}

	// only use the current token if it has at least 20 seconds before expiry
	if currentToken.Expiry.After(time.Now().Add(time.Duration(20) * time.Second)) {
		logger.Logger.Debug("Using existing Alby OAuth token")
		return currentToken, nil
	}

	newToken, err := svc.oauthConf.TokenSource(ctx, currentToken).Token()
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to refresh existing token")
		return nil, err
	}

	svc.saveToken(newToken)
	return newToken, nil
}

func (svc *albyOAuthService) GetMe(ctx context.Context) (*AlbyMe, error) {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
		return nil, err
	}

	client := svc.oauthConf.Client(ctx, token)

	req, err := http.NewRequest("GET", fmt.Sprintf("%s/internal/users", svc.cfg.GetEnv().AlbyAPIURL), nil)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request /me")
		return nil, err
	}

	setDefaultRequestHeaders(req)

	res, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch /me")
		return nil, err
	}

	me := &AlbyMe{}
	err = json.NewDecoder(res.Body).Decode(me)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to decode API response")
		return nil, err
	}

	svc.cfg.SetUpdate(lightningAddressKey, me.LightningAddress, "")

	logger.Logger.WithFields(logrus.Fields{"me": me}).Info("Alby me response")
	return me, nil
}

func (svc *albyOAuthService) GetBalance(ctx context.Context) (*AlbyBalance, error) {

	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
		return nil, err
	}

	client := svc.oauthConf.Client(ctx, token)

	req, err := http.NewRequest("GET", fmt.Sprintf("%s/internal/lndhub/balance", svc.cfg.GetEnv().AlbyAPIURL), nil)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request to balance endpoint")
		return nil, err
	}

	setDefaultRequestHeaders(req)

	res, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch balance endpoint")
		return nil, err
	}
	balance := &AlbyBalance{}
	err = json.NewDecoder(res.Body).Decode(balance)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to decode API response")
		return nil, err
	}

	logger.Logger.WithFields(logrus.Fields{"balance": balance}).Debug("Alby balance response")
	return balance, nil
}

func (svc *albyOAuthService) DrainSharedWallet(ctx context.Context, lnClient lnclient.LNClient) error {
	balance, err := svc.GetBalance(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch shared balance")
		return err
	}

	balanceSat := float64(balance.Balance)

	amountSat := int64(math.Floor(
		balanceSat- // Alby shared node balance in sats
			(balanceSat*(8.0/1000.0))- // Alby service fee (0.8%)
			(balanceSat*0.01))) - // Maximum potential routing fees (1%)
		10 // Alby fee reserve (10 sats)

	if amountSat < 1 {
		return errors.New("Not enough balance remaining")
	}
	amount := amountSat * 1000

	logger.Logger.WithField("amount", amount).WithError(err).Error("Draining Alby shared wallet funds")

	transaction, err := transactions.NewTransactionsService(svc.db, svc.eventPublisher).MakeInvoice(ctx, amount, "Send shared wallet funds to Alby Hub", "", 120, nil, lnClient, nil, nil)
	if err != nil {
		logger.Logger.WithField("amount", amount).WithError(err).Error("Failed to make invoice")
		return err
	}

	err = svc.SendPayment(ctx, transaction.PaymentRequest)
	if err != nil {
		logger.Logger.WithField("amount", amount).WithError(err).Error("Failed to pay invoice from shared node")
		return err
	}
	return nil
}

func (svc *albyOAuthService) SendPayment(ctx context.Context, invoice string) error {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
		return err
	}

	client := svc.oauthConf.Client(ctx, token)

	type payRequest struct {
		Invoice string `json:"invoice"`
	}

	body := bytes.NewBuffer([]byte{})
	payload := payRequest{
		Invoice: invoice,
	}
	err = json.NewEncoder(body).Encode(&payload)

	if err != nil {
		logger.Logger.WithError(err).Error("Failed to encode request payload")
		return err
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/internal/lndhub/bolt11", svc.cfg.GetEnv().AlbyAPIURL), body)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request bolt11 endpoint")
		return err
	}

	setDefaultRequestHeaders(req)

	resp, err := client.Do(req)
	if err != nil {
		logger.Logger.WithFields(logrus.Fields{
			"invoice": invoice,
		}).WithError(err).Error("Failed to pay invoice")
		return err
	}

	type PayResponse struct {
		Preimage    string `json:"payment_preimage"`
		PaymentHash string `json:"payment_hash"`
	}

	if resp.StatusCode >= 300 {

		type ErrorResponse struct {
			Error   bool   `json:"error"`
			Code    int    `json:"code"`
			Message string `json:"message"`
		}

		errorPayload := &ErrorResponse{}
		err = json.NewDecoder(resp.Body).Decode(errorPayload)
		if err != nil {
			logger.Logger.WithFields(logrus.Fields{
				"status": resp.StatusCode,
			}).WithError(err).Error("Failed to decode payment error response payload")
			return err
		}

		logger.Logger.WithFields(logrus.Fields{
			"invoice": invoice,
			"status":  resp.StatusCode,
			"message": errorPayload.Message,
		}).Error("Payment failed")
		return errors.New(errorPayload.Message)
	}

	responsePayload := &PayResponse{}
	err = json.NewDecoder(resp.Body).Decode(responsePayload)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to decode response payload")
		return err
	}
	logger.Logger.WithFields(logrus.Fields{
		"invoice":     invoice,
		"paymentHash": responsePayload.PaymentHash,
		"preimage":    responsePayload.Preimage,
	}).Info("Alby Payment successful")
	return nil
}

func (svc *albyOAuthService) GetAuthUrl() string {
	if svc.cfg.GetEnv().AlbyClientId == "" || svc.cfg.GetEnv().AlbyClientSecret == "" {
		logger.Logger.Fatalf("No ALBY_OAUTH_CLIENT_ID or ALBY_OAUTH_CLIENT_SECRET set")
	}
	return svc.oauthConf.AuthCodeURL("unused")
}

func (svc *albyOAuthService) UnlinkAccount(ctx context.Context) error {
	err := svc.destroyAlbyAccountNWCNode(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to destroy Alby Account NWC node")
	}
	svc.deleteAlbyAccountApps()

	svc.cfg.SetUpdate(userIdentifierKey, "", "")
	svc.cfg.SetUpdate(accessTokenKey, "", "")
	svc.cfg.SetUpdate(accessTokenExpiryKey, "", "")
	svc.cfg.SetUpdate(refreshTokenKey, "", "")
	svc.cfg.SetUpdate(lightningAddressKey, "", "")

	return nil
}

func (svc *albyOAuthService) LinkAccount(ctx context.Context, lnClient lnclient.LNClient, budget uint64, renewal string) error {
	svc.deleteAlbyAccountApps()

	connectionPubkey, err := svc.createAlbyAccountNWCNode(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to create alby account nwc node")
		return err
	}

	scopes, err := permissions.RequestMethodsToScopes(lnClient.GetSupportedNIP47Methods())
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to get scopes from LNClient request methods")
		return err
	}
	notificationTypes := lnClient.GetSupportedNIP47NotificationTypes()
	if len(notificationTypes) > 0 {
		scopes = append(scopes, constants.NOTIFICATIONS_SCOPE)
	}

	app, _, err := db.NewDBService(svc.db, svc.eventPublisher).CreateApp(
		ALBY_ACCOUNT_APP_NAME,
		connectionPubkey,
		budget,
		renewal,
		nil,
		scopes,
		false,
		nil,
	)

	if err != nil {
		logger.Logger.WithError(err).Error("Failed to create app connection")
		return err
	}

	logger.Logger.WithFields(logrus.Fields{
		"app": app,
	}).Info("Created alby app connection")

	err = svc.activateAlbyAccountNWCNode(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to activate alby account nwc node")
		return err
	}

	return nil
}

func (svc *albyOAuthService) ConsumeEvent(ctx context.Context, event *events.Event, globalProperties map[string]interface{}) {
	defer func() {
		// ensure the app cannot panic if firing events to Alby API fails
		if r := recover(); r != nil {
			logger.Logger.WithField("event", event).WithField("r", r).Error("Failed to consume event in alby oauth service")
		}
	}()

	accessToken, err := svc.cfg.Get(accessTokenKey, "")
	if err != nil {
		logger.Logger.WithError(err).Error("failed to get access token from config")
		return
	}

	if accessToken == "" {
		logger.Logger.WithFields(logrus.Fields{
			"event": event,
		}).Debug("user has not authed yet, skipping event")
		return
	}

	// TODO: we should have a whitelist rather than a blacklist, so new events are not automatically sent

	// TODO: rename this config option to be specific to the alby API
	if !svc.cfg.GetEnv().LogEvents {
		logger.Logger.WithField("event", event).Debug("Skipped sending to alby events API")
		return
	}

	if event.Event == "nwc_backup_channels" {
		if err := svc.backupChannels(ctx, event); err != nil {
			logger.Logger.WithError(err).Error("Failed to backup channels")
		}
		return
	}

	if strings.HasPrefix(event.Event, "nwc_lnclient_") {
		// don't consume internal LNClient events
		return
	}

	if event.Event == "nwc_payment_received" {
		type paymentReceivedEventProperties struct {
			PaymentHash string `json:"payment_hash"`
		}
		// pass a new custom event with less detail
		event = &events.Event{
			Event: event.Event,
			Properties: &paymentReceivedEventProperties{
				PaymentHash: event.Properties.(*db.Transaction).PaymentHash,
			},
		}
	}

	if event.Event == "nwc_payment_sent" {
		type paymentSentEventProperties struct {
			PaymentHash string `json:"payment_hash"`
			Duration    uint64 `json:"duration"`
		}

		// pass a new custom event with less detail
		event = &events.Event{
			Event: event.Event,
			Properties: &paymentSentEventProperties{
				PaymentHash: event.Properties.(*db.Transaction).PaymentHash,
				Duration:    uint64(event.Properties.(*db.Transaction).SettledAt.Unix() - event.Properties.(*db.Transaction).CreatedAt.Unix()),
			},
		}
	}

	if event.Event == "nwc_payment_failed" {
		transaction, ok := event.Properties.(*db.Transaction)
		if !ok {
			logger.Logger.WithField("event", event).Error("Failed to cast event")
			return
		}

		type paymentFailedEventProperties struct {
			PaymentHash string `json:"payment_hash"`
			Reason      string `json:"reason"`
		}

		// pass a new custom event with less detail
		event = &events.Event{
			Event: event.Event,
			Properties: &paymentFailedEventProperties{
				PaymentHash: transaction.PaymentHash,
				Reason:      transaction.FailureReason,
			},
		}
	}

	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
		return
	}

	client := svc.oauthConf.Client(ctx, token)

	// encode event without global properties
	originalEventBuffer := bytes.NewBuffer([]byte{})
	err = json.NewEncoder(originalEventBuffer).Encode(event)

	if err != nil {
		logger.Logger.WithError(err).Error("Failed to encode request payload")
		return
	}

	type eventWithPropertiesMap struct {
		Event      string                 `json:"event"`
		Properties map[string]interface{} `json:"properties"`
	}

	var eventWithGlobalProperties eventWithPropertiesMap
	err = json.Unmarshal(originalEventBuffer.Bytes(), &eventWithGlobalProperties)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to decode request payload")
		return
	}
	if eventWithGlobalProperties.Properties == nil {
		eventWithGlobalProperties.Properties = map[string]interface{}{}
	}

	// add global properties to each published event
	for k, v := range globalProperties {
		_, exists := eventWithGlobalProperties.Properties[k]
		if exists {
			logger.Logger.WithField("key", k).Error("Key already exists in event properties, skipping global property")
			continue
		}
		eventWithGlobalProperties.Properties[k] = v
	}

	body := bytes.NewBuffer([]byte{})
	err = json.NewEncoder(body).Encode(&eventWithGlobalProperties)

	if err != nil {
		logger.Logger.WithError(err).Error("Failed to encode request payload")
		return
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/events", svc.cfg.GetEnv().AlbyAPIURL), body)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request /events")
		return
	}

	setDefaultRequestHeaders(req)

	resp, err := client.Do(req)
	if err != nil {
		logger.Logger.WithFields(logrus.Fields{
			"event": eventWithGlobalProperties,
		}).WithError(err).Error("Failed to send request to /events")
		return
	}

	if resp.StatusCode >= 300 {
		logger.Logger.WithFields(logrus.Fields{
			"event":  eventWithGlobalProperties,
			"status": resp.StatusCode,
		}).Error("Request to /events returned non-success status")
		return
	}
}

func (svc *albyOAuthService) backupChannels(ctx context.Context, event *events.Event) error {
	bkpEvent, ok := event.Properties.(*events.ChannelBackupEvent)
	if !ok {
		return fmt.Errorf("invalid nwc_backup_channels event properties, could not cast to the expected type: %+v", event.Properties)
	}

	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		return fmt.Errorf("failed to fetch user token: %w", err)
	}

	client := svc.oauthConf.Client(ctx, token)

	type channelsBackup struct {
		Description string `json:"description"`
		Data        string `json:"data"`
	}

	channelsData := bytes.NewBuffer([]byte{})
	err = json.NewEncoder(channelsData).Encode(bkpEvent.Channels)
	if err != nil {
		return fmt.Errorf("failed to encode channels backup data:  %w", err)
	}

	// use the encrypted mnemonic as the password to encrypt the backup data
	encryptedMnemonic, err := svc.cfg.Get("Mnemonic", "")
	if err != nil {
		return fmt.Errorf("failed to fetch encryption key: %w", err)
	}

	encrypted, err := config.AesGcmEncrypt(channelsData.String(), encryptedMnemonic)
	if err != nil {
		return fmt.Errorf("failed to encrypt channels backup data: %w", err)
	}

	body := bytes.NewBuffer([]byte{})
	err = json.NewEncoder(body).Encode(&channelsBackup{
		Description: "channels",
		Data:        encrypted,
	})
	if err != nil {
		return fmt.Errorf("failed to encode channels backup request payload: %w", err)
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/internal/backups", svc.cfg.GetEnv().AlbyAPIURL), body)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	setDefaultRequestHeaders(req)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request to /internal/backups: %w", err)
	}

	if resp.StatusCode >= 300 {
		return fmt.Errorf("request to /internal/backups returned non-success status: %d", resp.StatusCode)
	}

	return nil
}

func (svc *albyOAuthService) createAlbyAccountNWCNode(ctx context.Context) (string, error) {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
	}

	client := svc.oauthConf.Client(ctx, token)

	type createNWCNodeRequest struct {
		WalletPubkey string `json:"wallet_pubkey"`
	}

	createNodeRequest := createNWCNodeRequest{
		WalletPubkey: svc.keys.GetNostrPublicKey(),
	}

	body := bytes.NewBuffer([]byte{})
	err = json.NewEncoder(body).Encode(&createNodeRequest)

	if err != nil {
		logger.Logger.WithError(err).Error("Failed to encode request payload")
		return "", err
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/internal/nwcs", svc.cfg.GetEnv().AlbyAPIURL), body)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request /internal/nwcs")
		return "", err
	}

	setDefaultRequestHeaders(req)

	resp, err := client.Do(req)
	if err != nil {
		logger.Logger.WithFields(logrus.Fields{
			"createNodeRequest": createNodeRequest,
		}).WithError(err).Error("Failed to send request to /internal/nwcs")
		return "", err
	}

	if resp.StatusCode >= 300 {
		logger.Logger.WithFields(logrus.Fields{
			"createNodeRequest": createNodeRequest,
			"status":            resp.StatusCode,
		}).Error("Request to /internal/nwcs returned non-success status")
		return "", errors.New("request to /internal/nwcs returned non-success status")
	}

	type CreateNWCNodeResponse struct {
		Pubkey string `json:"pubkey"`
	}

	responsePayload := &CreateNWCNodeResponse{}
	err = json.NewDecoder(resp.Body).Decode(responsePayload)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to decode response payload")
		return "", err
	}

	logger.Logger.WithFields(logrus.Fields{
		"pubkey": responsePayload.Pubkey,
	}).Info("Created alby nwc node successfully")

	return responsePayload.Pubkey, nil
}

func (svc *albyOAuthService) destroyAlbyAccountNWCNode(ctx context.Context) error {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
	}

	client := svc.oauthConf.Client(ctx, token)

	req, err := http.NewRequest("DELETE", fmt.Sprintf("%s/internal/nwcs", svc.cfg.GetEnv().AlbyAPIURL), nil)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request /internal/nwcs")
		return err
	}

	setDefaultRequestHeaders(req)

	resp, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to send request to /internal/nwcs")
		return err
	}

	if resp.StatusCode >= 300 {
		logger.Logger.WithFields(logrus.Fields{
			"status": resp.StatusCode,
		}).Error("Request to /internal/nwcs returned non-success status")
		return errors.New("request to /internal/nwcs returned non-success status")
	}

	logger.Logger.Info("Removed alby account nwc node successfully")

	return nil
}

func (svc *albyOAuthService) activateAlbyAccountNWCNode(ctx context.Context) error {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
	}

	client := svc.oauthConf.Client(ctx, token)

	req, err := http.NewRequest("PUT", fmt.Sprintf("%s/internal/nwcs/activate", svc.cfg.GetEnv().AlbyAPIURL), nil)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request /internal/nwcs/activate")
		return err
	}

	setDefaultRequestHeaders(req)

	resp, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to send request to /internal/nwcs/activate")
		return err
	}

	if resp.StatusCode >= 300 {
		logger.Logger.WithFields(logrus.Fields{
			"status": resp.StatusCode,
		}).Error("Request to /internal/nwcs/activate returned non-success status")
		return errors.New("request to /internal/nwcs/activate returned non-success status")
	}

	logger.Logger.Info("Activated alby nwc node successfully")

	return nil
}

func (svc *albyOAuthService) GetChannelPeerSuggestions(ctx context.Context) ([]ChannelPeerSuggestion, error) {

	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
		return nil, err
	}

	client := svc.oauthConf.Client(ctx, token)

	req, err := http.NewRequest("GET", fmt.Sprintf("%s/internal/channel_suggestions", svc.cfg.GetEnv().AlbyAPIURL), nil)
	if err != nil {
		logger.Logger.WithError(err).Error("Error creating request to channel_suggestions endpoint")
		return nil, err
	}

	setDefaultRequestHeaders(req)

	res, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch channel_suggestions endpoint")
		return nil, err
	}
	var suggestions []ChannelPeerSuggestion
	err = json.NewDecoder(res.Body).Decode(&suggestions)
	if err != nil {
		logger.Logger.WithError(err).Errorf("Failed to decode API response")
		return nil, err
	}

	// TODO: remove once alby API is updated
	for i, suggestion := range suggestions {
		if suggestion.BrokenLspType != "" {
			suggestions[i].LspType = suggestion.BrokenLspType
		}
		if suggestion.BrokenLspUrl != "" {
			suggestions[i].LspUrl = suggestion.BrokenLspUrl
		}
	}

	logger.Logger.WithFields(logrus.Fields{"channel_suggestions": suggestions}).Debug("Alby channel peer suggestions response")
	return suggestions, nil
}

func (svc *albyOAuthService) RequestAutoChannel(ctx context.Context, lnClient lnclient.LNClient, isPublic bool) (*AutoChannelResponse, error) {
	nodeInfo, err := lnClient.GetInfo(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to request own node info", err)
		return nil, err
	}

	requestUrl := fmt.Sprintf("https://api.getalby.com/internal/lsp/alby/%s", nodeInfo.Network)

	pubkey, address, port, err := svc.getLSPInfo(ctx, requestUrl+"/v1/get_info")

	if err != nil {
		logger.Logger.WithError(err).Error("Failed to request LSP info")
		return nil, err
	}

	err = lnClient.ConnectPeer(ctx, &lnclient.ConnectPeerRequest{
		Pubkey:  pubkey,
		Address: address,
		Port:    port,
	})

	if err != nil {
		logger.Logger.WithFields(logrus.Fields{
			"pubkey":  pubkey,
			"address": address,
			"port":    port,
		}).WithError(err).Error("Failed to connect to peer")
		return nil, err
	}

	logger.Logger.WithFields(logrus.Fields{
		"pubkey": pubkey,
		"public": isPublic,
	}).Info("Requesting auto channel")

	autoChannelResponse, err := svc.requestAutoChannel(ctx, requestUrl+"/auto_channel", nodeInfo.Pubkey, isPublic)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to request auto channel")
		return nil, err
	}
	return autoChannelResponse, nil
}

func (svc *albyOAuthService) requestAutoChannel(ctx context.Context, url string, pubkey string, isPublic bool) (*AutoChannelResponse, error) {
	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
	}

	client := svc.oauthConf.Client(ctx, token)
	client.Timeout = 60 * time.Second

	type autoChannelRequest struct {
		NodePubkey      string `json:"node_pubkey"`
		AnnounceChannel bool   `json:"announce_channel"`
	}

	newAutoChannelRequest := autoChannelRequest{
		NodePubkey:      pubkey,
		AnnounceChannel: isPublic,
	}

	payloadBytes, err := json.Marshal(newAutoChannelRequest)
	if err != nil {
		return nil, err
	}
	bodyReader := bytes.NewReader(payloadBytes)

	req, err := http.NewRequest(http.MethodPost, url, bodyReader)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to create auto channel request")
		return nil, err
	}

	setDefaultRequestHeaders(req)

	res, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to request auto channel invoice")
		return nil, err
	}

	defer res.Body.Close()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to read response body")
		return nil, errors.New("failed to read response body")
	}

	if res.StatusCode >= 300 {
		logger.Logger.WithFields(logrus.Fields{
			"newLSPS1ChannelRequest": newAutoChannelRequest,
			"body":                   string(body),
			"statusCode":             res.StatusCode,
		}).Error("auto channel endpoint returned non-success code")
		return nil, fmt.Errorf("auto channel endpoint returned non-success code: %s", string(body))
	}

	type newLSPS1ChannelPaymentBolt11 struct {
		Invoice     string `json:"invoice"`
		FeeTotalSat string `json:"fee_total_sat"`
	}

	type newLSPS1ChannelPayment struct {
		Bolt11 newLSPS1ChannelPaymentBolt11 `json:"bolt11"`
		// TODO: add onchain
	}
	type autoChannelResponse struct {
		LspBalanceSat string                  `json:"lsp_balance_sat"`
		Payment       *newLSPS1ChannelPayment `json:"payment"`
	}

	var newAutoChannelResponse autoChannelResponse

	err = json.Unmarshal(body, &newAutoChannelResponse)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to deserialize json")
		return nil, fmt.Errorf("failed to deserialize json %s %s", url, string(body))
	}

	var invoice string
	var fee uint64

	if newAutoChannelResponse.Payment != nil {
		invoice = newAutoChannelResponse.Payment.Bolt11.Invoice
		fee, err = strconv.ParseUint(newAutoChannelResponse.Payment.Bolt11.FeeTotalSat, 10, 64)
		if err != nil {
			logger.Logger.WithError(err).WithFields(logrus.Fields{
				"url": url,
			}).Error("Failed to parse fee")
			return nil, fmt.Errorf("failed to parse fee %v", err)
		}

		paymentRequest, err := decodepay.Decodepay(invoice)
		if err != nil {
			logger.Logger.WithError(err).Error("Failed to decode bolt11 invoice")
			return nil, err
		}

		if fee != uint64(paymentRequest.MSatoshi/1000) {
			logger.Logger.WithFields(logrus.Fields{
				"invoice_amount": paymentRequest.MSatoshi / 1000,
				"fee":            fee,
			}).WithError(err).Error("Invoice amount does not match LSP fee")
			return nil, errors.New("invoice amount does not match LSP fee")
		}
	}

	channelSize, err := strconv.ParseUint(newAutoChannelResponse.LspBalanceSat, 10, 64)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to parse lsp balance sat")
		return nil, fmt.Errorf("failed to parse lsp balance sat %v", err)
	}

	return &AutoChannelResponse{
		Invoice:     invoice,
		Fee:         fee,
		ChannelSize: channelSize,
	}, nil
}

func (svc *albyOAuthService) getLSPInfo(ctx context.Context, url string) (pubkey string, address string, port uint16, err error) {

	token, err := svc.fetchUserToken(ctx)
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to fetch user token")
	}

	client := svc.oauthConf.Client(ctx, token)
	client.Timeout = 60 * time.Second

	type lsps1LSPInfo struct {
		URIs []string `json:"uris"`
	}
	var lsps1LspInfo lsps1LSPInfo

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to create lsp info request")
		return "", "", uint16(0), err
	}

	setDefaultRequestHeaders(req)

	res, err := client.Do(req)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to request lsp info")
		return "", "", uint16(0), err
	}

	defer res.Body.Close()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to read response body")
		return "", "", uint16(0), errors.New("failed to read response body")
	}

	err = json.Unmarshal(body, &lsps1LspInfo)
	if err != nil {
		logger.Logger.WithError(err).WithFields(logrus.Fields{
			"url": url,
		}).Error("Failed to deserialize json")
		return "", "", uint16(0), fmt.Errorf("failed to deserialize json %s %s", url, string(body))
	}

	httpUris := utils.Filter(lsps1LspInfo.URIs, func(uri string) bool {
		return !strings.Contains(uri, ".onion")
	})
	if len(httpUris) == 0 {
		logger.Logger.WithField("uris", lsps1LspInfo.URIs).WithError(err).Error("Couldn't find HTTP URI")

		return "", "", uint16(0), err
	}
	uri := httpUris[0]

	// make sure it's a valid IPv4 URI
	regex := regexp.MustCompile(`^([0-9a-f]+)@([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)$`)
	parts := regex.FindStringSubmatch(uri)
	logger.Logger.WithField("parts", parts).Debug("Split URI")
	if parts == nil || len(parts) != 4 {
		logger.Logger.WithField("parts", parts).Error("Unsupported URI")
		return "", "", uint16(0), errors.New("could not decode LSP URI")
	}

	portValue, err := strconv.Atoi(parts[3])
	if err != nil {
		logger.Logger.WithField("port", parts[3]).WithError(err).Error("Failed to decode port number")

		return "", "", uint16(0), err
	}

	return parts[1], parts[2], uint16(portValue), nil
}

func setDefaultRequestHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "AlbyHub/"+version.Tag)
}

func (svc *albyOAuthService) deleteAlbyAccountApps() {
	// delete any existing getalby.com connections so when re-linking the user only has one
	err := svc.db.Where("name = ?", ALBY_ACCOUNT_APP_NAME).Delete(&db.App{}).Error
	if err != nil {
		logger.Logger.WithError(err).Error("Failed to delete Alby Account apps")
	}
}
