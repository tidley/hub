import { CopyIcon } from "lucide-react";
import React from "react";
import AppHeader from "src/components/AppHeader";
import AppCard from "src/components/connections/AppCard";
import ExternalLink from "src/components/ExternalLink";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "src/components/ui/accordion";
import { Button } from "src/components/ui/button";
import { Input } from "src/components/ui/input";
import { Label } from "src/components/ui/label";
import { LoadingButton } from "src/components/ui/loading-button";
import { Textarea } from "src/components/ui/textarea";
import { useToast } from "src/components/ui/use-toast";
import { useApp } from "src/hooks/useApp";
import { useApps } from "src/hooks/useApps";
import { useNodeConnectionInfo } from "src/hooks/useNodeConnectionInfo";
import { copyToClipboard } from "src/lib/clipboard";
import { createApp } from "src/requests/createApp";
import { ConnectAppCard } from "src/screens/apps/AppCreated";
import { CreateAppRequest } from "src/types";
import { handleRequestError } from "src/utils/handleRequestError";

export function UncleJim() {
  const [name, setName] = React.useState("");
  const [appPublicKey, setAppPublicKey] = React.useState("");
  const [connectionSecret, setConnectionSecret] = React.useState("");
  const { data: apps } = useApps();
  const { data: app } = useApp(appPublicKey, true);
  const { data: nodeConnectionInfo } = useNodeConnectionInfo();
  const { toast } = useToast();
  const [isLoading, setLoading] = React.useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);

    try {
      if (apps?.some((existingApp) => existingApp.name === name)) {
        throw new Error("A connection with the same name already exists.");
      }

      const createAppRequest: CreateAppRequest = {
        name,
        scopes: [
          "get_balance",
          "get_info",
          "list_transactions",
          "lookup_invoice",
          "make_invoice",
          "notifications",
          "pay_invoice",
        ],
        isolated: true,
        metadata: {
          app_store_app_id: "uncle-jim",
        },
      };

      const createAppResponse = await createApp(createAppRequest);

      setConnectionSecret(createAppResponse.pairingUri);
      setAppPublicKey(createAppResponse.pairingPublicKey);

      toast({ title: "New subaccount created for " + name });
    } catch (error) {
      handleRequestError(toast, "Failed to create app", error);
    }
    setLoading(false);
  };

  const albyAccountUrl = `https://getalby.com/nwc/new#${connectionSecret}`;
  const valueTag = `<podcast:value type="lightning" method="keysend">
  <podcast:valueRecipient name="${name}" type="node" address="${nodeConnectionInfo?.pubkey}" customKey="696969"  customValue="${app?.id}" split="100"/>
</podcast:value>`;

  const onboardedApps = apps?.filter(
    (app) => app.metadata?.app_store_app_id === "uncle-jim"
  );

  return (
    <div className="grid gap-5">
      <AppHeader
        title="Friends & Family"
        description="Create subaccounts for your friends and family powered by your Hub"
      />
      {!connectionSecret && (
        <>
          <form
            onSubmit={handleSubmit}
            className="flex flex-col items-start gap-5 max-w-lg"
          >
            <div className="w-full grid gap-1.5">
              <Label htmlFor="name">Name of friend or family member</Label>
              <Input
                autoFocus
                type="text"
                name="name"
                value={name}
                id="name"
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="off"
                placeholder="John Galt"
              />
            </div>
            <LoadingButton loading={isLoading} type="submit">
              Create Subaccount
            </LoadingButton>
          </form>

          {!!onboardedApps?.length && (
            <>
              <p className="text-sm text-muted-foreground">
                Great job! You've onboarded {onboardedApps.length} friends and
                family members so far.
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch app-list">
                {onboardedApps.map((app, index) => (
                  <AppCard key={index} app={app} />
                ))}
              </div>{" "}
            </>
          )}
        </>
      )}
      {connectionSecret && (
        <div className="grid gap-5 max-w-lg">
          <p className="text-muted-foreground text-sm">
            Step 2. Onboard {name} to their new wallet
          </p>
          <Accordion type="single" collapsible>
            <AccordionItem value="mobile">
              <AccordionTrigger>Alby Mobile</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground text-sm mb-5">
                  1. Ask {name} to download the Alby Mobile app from Google Play
                  or the iOS App Store
                </p>
                <p className="text-muted-foreground text-sm mb-5">
                  2. Ask {name} to scan the below QR code.
                </p>
                {app && (
                  <ConnectAppCard app={app} pairingUri={connectionSecret} />
                )}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="account">
              <AccordionTrigger>Alby Account</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground text-sm mb-5">
                  1. Send {name} an{" "}
                  <ExternalLink
                    to="https://getalby.com/invite_codes"
                    className="underline"
                  >
                    Alby Account invitation
                  </ExternalLink>{" "}
                  if they don't have one yet.
                </p>
                <p className="text-muted-foreground text-sm mb-5">
                  2. Send {name} the below link which will link the new wallet
                  to their Alby Account. Do not to share this publicly as it
                  contains the connection secret for their wallet.
                </p>
                <div className="flex gap-2">
                  <Input
                    disabled
                    readOnly
                    type="password"
                    value={albyAccountUrl}
                  />
                  <Button
                    onClick={() => copyToClipboard(albyAccountUrl, toast)}
                    variant="outline"
                  >
                    <CopyIcon className="w-4 h-4 mr-2" />
                    Copy
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="extension">
              <AccordionTrigger>Alby Extension</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground text-sm mb-5">
                  1. Send {name} the below connection secret which they can add
                  to their Alby Extension by choosing "Bring Your Own Wallet"{" "}
                  {"->"} "Nostr Wallet Connect" and pasting the connection
                  secret. Do not to share this publicly as it contains the
                  connection secret for their wallet.
                </p>
                <div className="flex gap-2">
                  <Input
                    disabled
                    readOnly
                    type="password"
                    value={connectionSecret}
                  />
                  <Button
                    onClick={() => copyToClipboard(connectionSecret, toast)}
                    variant="outline"
                  >
                    <CopyIcon className="w-4 h-4 mr-2" />
                    Copy
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="podcasting">
              <AccordionTrigger>Podcasting 2.0</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground text-sm mb-5">
                  1. Make sure to give {name} access to their wallet with one of
                  the options above.
                </p>
                <p className="text-muted-foreground text-sm mb-5">
                  2. Send them this value tag which they can add to their RSS
                  feed.
                </p>
                <div className="flex gap-2">
                  <Textarea readOnly className="h-36" value={valueTag} />
                  <Button
                    onClick={() => copyToClipboard(valueTag, toast)}
                    variant="outline"
                  >
                    <CopyIcon className="w-4 h-4 mr-2" />
                    Copy
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </div>
  );
}
