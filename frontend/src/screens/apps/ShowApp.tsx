import React from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useApp } from "src/hooks/useApp";

import { useDeleteApp } from "src/hooks/useDeleteApp";
import {
  App,
  AppPermissions,
  UpdateAppRequest,
  WalletCapabilities,
} from "src/types";

import { handleRequestError } from "src/utils/handleRequestError";
import { request } from "src/utils/request"; // build the project for this to appear

import { PencilIcon } from "lucide-react";
import AppAvatar from "src/components/AppAvatar";
import AppHeader from "src/components/AppHeader";
import Loading from "src/components/Loading";
import Permissions from "src/components/Permissions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "src/components/ui/alert-dialog";
import { Button } from "src/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "src/components/ui/card";
import { Input } from "src/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "src/components/ui/table";
import { useToast } from "src/components/ui/use-toast";
import { useApps } from "src/hooks/useApps";
import { useCapabilities } from "src/hooks/useCapabilities";
import { formatAmount } from "src/lib/utils";

function ShowApp() {
  const { pubkey } = useParams() as { pubkey: string };
  const { data: app, mutate: refetchApp, error } = useApp(pubkey);
  const { data: capabilities } = useCapabilities();

  if (error) {
    return <p className="text-red-500">{error.message}</p>;
  }

  if (!app || !capabilities) {
    return <Loading />;
  }

  return (
    <AppInternal
      app={app}
      refetchApp={refetchApp}
      capabilities={capabilities}
    />
  );
}

type AppInternalProps = {
  app: App;
  capabilities: WalletCapabilities;
  refetchApp: () => void;
};

function AppInternal({ app, refetchApp, capabilities }: AppInternalProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: apps } = useApps();
  const [isEditingName, setIsEditingName] = React.useState(false);
  const [isEditingPermissions, setIsEditingPermissions] = React.useState(false);

  React.useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const editMode = queryParams.has("edit");
    setIsEditingPermissions(editMode);
  }, [location.search]);

  const { deleteApp, isDeleting } = useDeleteApp(() => {
    navigate("/apps");
  });

  const [name, setName] = React.useState(app.name);
  const [permissions, setPermissions] = React.useState<AppPermissions>({
    scopes: app.scopes,
    maxAmount: app.maxAmount,
    budgetRenewal: app.budgetRenewal,
    expiresAt: app.expiresAt ? new Date(app.expiresAt) : undefined,
    isolated: app.isolated,
  });

  const handleSave = async () => {
    try {
      if (
        isEditingName &&
        apps?.some(
          (existingApp) =>
            existingApp.name === name && existingApp.id !== app.id
        )
      ) {
        throw new Error("A connection with the same name already exists.");
      }

      const updateAppRequest: UpdateAppRequest = {
        name,
        scopes: Array.from(permissions.scopes),
        budgetRenewal: permissions.budgetRenewal,
        expiresAt: permissions.expiresAt?.toISOString(),
        maxAmount: permissions.maxAmount,
      };

      await request(`/api/apps/${app.nostrPubkey}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateAppRequest),
      });

      await refetchApp();
      setIsEditingName(false);
      setIsEditingPermissions(false);
      toast({
        title: "Successfully updated connection",
      });
    } catch (error) {
      handleRequestError(toast, "Failed to update connection", error);
    }
  };

  const appName = app.name === "getalby.com" ? "Alby Account" : app.name;

  return (
    <>
      <div className="w-full">
        <div className="flex flex-col gap-5">
          <AppHeader
            title={
              <div className="flex flex-row items-center">
                <AppAvatar app={app} className="w-10 h-10 mr-2" />
                {isEditingName ? (
                  <div className="flex flex-row gap-2 items-center">
                    <Input
                      autoFocus
                      type="text"
                      name="name"
                      value={name}
                      id="name"
                      onChange={(e) => setName(e.target.value)}
                      required
                      className="text-xl font-semibold w-max max-w-40 md:max-w-fit"
                      autoComplete="off"
                    />
                    <Button type="button" onClick={handleSave}>
                      Save
                    </Button>
                  </div>
                ) : (
                  <div
                    className="flex flex-row gap-2 items-center cursor-pointer"
                    onClick={() => setIsEditingName(true)}
                  >
                    <h2
                      title={appName}
                      className="text-xl font-semibold overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {appName}
                    </h2>
                    {app.name !== "getalby.com" && (
                      <PencilIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>
            }
            contentRight={
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">Delete</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will revoke the permission and will no longer allow
                      calls from this public key.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => deleteApp(app.nostrPubkey)}
                      disabled={isDeleting}
                    >
                      Continue
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            }
            description={""}
          />
          <Card>
            <CardHeader>
              <CardTitle>Info</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">Id</TableCell>
                    <TableCell className="text-muted-foreground break-all">
                      {app.id}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Public Key</TableCell>
                    <TableCell className="text-muted-foreground break-all">
                      {app.nostrPubkey}
                    </TableCell>
                  </TableRow>
                  {app.isolated && (
                    <TableRow>
                      <TableCell className="font-medium">Balance</TableCell>
                      <TableCell className="text-muted-foreground break-all">
                        {formatAmount(app.balance)} sats
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow>
                    <TableCell className="font-medium">Last used</TableCell>
                    <TableCell className="text-muted-foreground">
                      {app.lastEventAt
                        ? new Date(app.lastEventAt).toString()
                        : "Never"}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Expires At</TableCell>
                    <TableCell className="text-muted-foreground">
                      {app.expiresAt
                        ? new Date(app.expiresAt).toString()
                        : "Never"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <div className="flex flex-row justify-between items-center">
                  Permissions
                  <div className="flex flex-row gap-2">
                    {isEditingPermissions && (
                      <div className="flex justify-center items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            window.location.reload();
                          }}
                        >
                          Cancel
                        </Button>

                        <Button type="button" onClick={handleSave}>
                          Save
                        </Button>
                      </div>
                    )}

                    {!app.isolated && !isEditingPermissions && (
                      <>
                        <Button
                          variant="outline"
                          onClick={() =>
                            setIsEditingPermissions(!isEditingPermissions)
                          }
                        >
                          Edit
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Permissions
                capabilities={capabilities}
                permissions={permissions}
                setPermissions={setPermissions}
                readOnly={!isEditingPermissions}
                isNewConnection={false}
                budgetUsage={app.budgetUsage}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

export default ShowApp;
