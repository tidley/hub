import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useChannels } from "src/hooks/useChannels";
import { useInfo } from "src/hooks/useInfo";
import { useOnchainBalance } from "src/hooks/useOnchainBalance";
import { CloseChannelRequest, CloseChannelResponse, Node } from "src/types";
import { request } from "src/utils/request";
import { useCSRF } from "../../hooks/useCSRF.ts";
import { useRedeemOnchainFunds } from "src/hooks/useRedeemOnchainFunds.ts";
import Loading from "src/components/Loading.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "src/components/ui/card.tsx";

import { Cable, Bitcoin, Zap } from "lucide-react";
import AppHeader2 from "src/components/AppHeader2.tsx";

export default function Channels() {
  const { data: channels, mutate: reloadChannels } = useChannels();
  const { data: onchainBalance } = useOnchainBalance();
  const [nodes, setNodes] = React.useState<Node[]>([]);
  const { data: info, mutate: reloadInfo } = useInfo();
  const { data: csrf } = useCSRF();
  const navigate = useNavigate();
  const redeemOnchainFunds = useRedeemOnchainFunds();

  React.useEffect(() => {
    if (!info || info.running) {
      return;
    }
    navigate("/");
  }, [info, navigate]);

  const loadNodeStats = React.useCallback(async () => {
    if (!channels) {
      return [];
    }
    const nodes = await Promise.all(
      channels?.map(async (channel): Promise<Node | undefined> => {
        try {
          const response = await request<Node>(
            `/api/mempool/lightning/nodes/${channel.remotePubkey}`
          );
          return response;
        } catch (error) {
          console.error(error);
          return undefined;
        }
      })
    );
    setNodes(nodes.filter((node) => !!node) as Node[]);
  }, [channels]);

  React.useEffect(() => {
    loadNodeStats();
  }, [loadNodeStats]);

  const lightningBalance = channels
    ?.map((channel) => channel.localBalance)
    .reduce((a, b) => a + b, 0);

  async function closeChannel(
    channelId: string,
    nodeId: string,
    isActive: boolean
  ) {
    try {
      if (!csrf) {
        throw new Error("csrf not loaded");
      }
      if (!isActive) {
        if (
          !confirm(
            `This channel is inactive. Some channels require up to 6 onchain confirmations before they are usable. If you really want to continue, click OK.`
          )
        ) {
          return;
        }
      }
      if (
        !confirm(
          `Are you sure you want to close the channel with ${
            nodes.find((node) => node.public_key === nodeId)?.alias ||
            "Unknown Node"
          }?\n\nNode ID: ${nodeId}\n\nChannel ID: ${channelId}`
        )
      ) {
        return;
      }

      console.log(`🎬 Closing channel with ${nodeId}`);

      const closeChannelRequest: CloseChannelRequest = {
        channelId: channelId,
        nodeId: nodeId,
      };
      const closeChannelResponse = await request<CloseChannelResponse>(
        "/api/channels/close",
        {
          method: "POST",
          headers: {
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(closeChannelRequest),
        }
      );

      if (!closeChannelResponse) {
        throw new Error("Error closing channel");
      }

      await reloadChannels();

      alert(`🎉 Channel closed`);
    } catch (error) {
      console.error(error);
      alert("Something went wrong: " + error);
    }
  }

  async function resetRouter() {
    try {
      if (!csrf) {
        throw new Error("csrf not loaded");
      }

      await request("/api/reset-router", {
        method: "POST",
        headers: {
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
      });
      await reloadInfo();
      alert(`🎉 Router reset`);
    } catch (error) {
      console.error(error);
      alert("Something went wrong: " + error);
    }
  }

  async function stopNode() {
    try {
      if (!csrf) {
        throw new Error("csrf not loaded");
      }

      await request("/api/stop", {
        method: "POST",
        headers: {
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
      });
      await reloadInfo();
      alert(`🎉 Node stopped`);
    } catch (error) {
      console.error(error);
      alert("Something went wrong: " + error);
    }
  }

  return (
    <>
      <AppHeader2
        title={"Channels"}
        description={"Manage liquidity on your lightnig node."}
      ></AppHeader2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Number of channels
            </CardTitle>
            <Cable className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {channels && channels.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              On-chain balance
            </CardTitle>
            <Bitcoin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!onchainBalance && (
              <div>
                <div className="animate-pulse d-inline ">
                  <div className="h-2.5 bg-gray-200 rounded-full dark:bg-gray-700 w-12 my-2"></div>
                </div>
              </div>
            )}
            <div className="text-2xl font-bold">
              {onchainBalance && (
                <>{formatAmount(onchainBalance.spendable * 1000)} sats</>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {onchainBalance &&
                onchainBalance.spendable !== onchainBalance.total && (
                  <span className="text-xs animate-pulse">
                    &nbsp;(
                    {onchainBalance.total - onchainBalance.spendable} incoming)
                  </span>
                )}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Lightning Balance
            </CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!channels && (
              <div>
                <div className="animate-pulse d-inline ">
                  <div className="h-2.5 bg-gray-200 rounded-full dark:bg-gray-700 w-12 my-2"></div>
                </div>
              </div>
            )}
            {lightningBalance !== undefined && (
              <div className="text-2xl font-bold">
                {formatAmount(lightningBalance)} sats
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <div>
        <Link
          to={`/channels/new`}
          className="text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 mr-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800"
        >
          Open a channel
        </Link>
        <Link
          to={`/channels/onchain/new-address`}
          className="text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 mr-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800"
        >
          Onchain address
        </Link>
        {info?.backendType === "LDK" && (
          <button
            onClick={resetRouter}
            className="text-white bg-orange-700 hover:bg-orange-800 focus:ring-4 focus:ring-orange-300 font-medium rounded-lg text-sm px-5 py-2.5 mr-2 dark:bg-orange-600 dark:hover:bg-orange-700 focus:outline-none dark:focus:ring-orange-800"
          >
            Reset Router
          </button>
        )}
        {info?.backendType === "LDK" && (
          <button
            onClick={stopNode}
            className="text-white bg-orange-700 hover:bg-orange-800 focus:ring-4 focus:ring-orange-300 font-medium rounded-lg text-sm px-5 py-2.5 mr-2 dark:bg-orange-600 dark:hover:bg-orange-700 focus:outline-none dark:focus:ring-orange-800"
          >
            Restart
          </button>
        )}
        {(info?.backendType === "LDK" || info?.backendType === "GREENLIGHT") &&
          (onchainBalance?.spendable || 0) > 0 && (
            <button
              onClick={redeemOnchainFunds.redeemFunds}
              disabled={redeemOnchainFunds.isLoading}
              className="text-white bg-orange-700 hover:bg-orange-800 focus:ring-4 focus:ring-orange-300 font-medium rounded-lg text-sm px-5 py-2.5 mr-2 dark:bg-orange-600 dark:hover:bg-orange-700 focus:outline-none dark:focus:ring-orange-800 inline-flex gap-2 justify-center items-center"
            >
              Redeem Onchain Funds {redeemOnchainFunds.isLoading && <Loading />}
            </button>
          )}

        <div className="flex flex-col mt-5">
          <div className="overflow-x-auto shadow-md sm:rounded-lg">
            <div className="inline-block min-w-full align-middle">
              <div className="overflow-hidden ">
                <table className="min-w-full divide-y divide-gray-200 table-fixed dark:divide-gray-700">
                  <thead className="bg-gray-100 dark:bg-gray-700">
                    <tr>
                      <th
                        scope="col"
                        className="py-3 px-6 text-xs font-medium tracking-wider text-left text-gray-700 uppercase dark:text-gray-400"
                      >
                        Node pubkey
                      </th>
                      <th
                        scope="col"
                        className="py-3 px-6 text-xs font-medium tracking-wider text-left text-gray-700 uppercase dark:text-gray-400"
                      >
                        Capacity
                      </th>
                      <th
                        scope="col"
                        className="w-96 py-3 px-6 text-xs font-medium tracking-wider text-left text-gray-700 uppercase dark:text-gray-400"
                      >
                        Local / Remote
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                    {!channels && (
                      <tr>
                        <td colSpan={6} className="text-center p-5">
                          <div
                            role="status"
                            className="animate-pulse flex space-between"
                          >
                            <div className="h-2.5 bg-gray-200 rounded-full w-1/3 dark:bg-gray-700 mr-5"></div>
                            <div className="h-2.5 bg-gray-200 rounded-full w-20 dark:bg-gray-700 mr-5"></div>
                            <div className="h-2.5 bg-gray-200 rounded-full w-20 dark:bg-gray-700"></div>
                            <span className="sr-only">Loading...</span>
                          </div>
                        </td>
                      </tr>
                    )}
                    {channels && channels.length > 0 && (
                      <>
                        {channels.map((channel) => {
                          // const localMaxPercentage =
                          //   maxChannelsBalance.local / 100;
                          // const remoteMaxPercentage =
                          //   maxChannelsBalance.remote / 100;
                          const node = nodes.find(
                            (n) => n.public_key === channel.remotePubkey
                          );
                          const alias = node?.alias || "Unknown";
                          const capacity =
                            channel.localBalance + channel.remoteBalance;
                          const localPercentage =
                            (channel.localBalance / capacity) * 100;
                          const remotePercentage =
                            (channel.remoteBalance / capacity) * 100;

                          return (
                            <tr
                              className="hover:bg-gray-100 dark:hover:bg-gray-700"
                              key={channel.id}
                            >
                              <td className="py-4 px-6 text-sm font-medium text-gray-900 whitespace-nowrap dark:text-white">
                                {channel.active ? "🟢" : "🔴"}{" "}
                                <a
                                  className="underline"
                                  title={channel.remotePubkey}
                                  href={`https://amboss.space/node/${channel.remotePubkey}`}
                                  target="_blank"
                                  rel="noopener noreferer"
                                >
                                  {alias} (
                                  {channel.remotePubkey.substring(0, 10)}
                                  ...)
                                </a>
                                <span className="mx-4 uppercase text-xs border-2 py-0.5 px-1 rounded-lg">
                                  {channel.public ? "Public" : "Private"}
                                </span>
                              </td>
                              <td className="py-4 px-6 text-sm font-medium text-gray-500 whitespace-nowrap dark:text-white">
                                {formatAmount(capacity)}
                              </td>
                              <td className="py-4 px-6 text-sm font-light text-right whitespace-nowrap dark:text-gray-400">
                                <div className="flex justify-between">
                                  <span>
                                    {formatAmount(channel.localBalance)}
                                  </span>
                                  <span>
                                    {formatAmount(channel.remoteBalance)}
                                  </span>
                                </div>

                                <div className="w-full flex justify-center items-center">
                                  <div
                                    className="bg-green-500 h-3 rounded-l-lg"
                                    style={{ width: `${localPercentage}%` }}
                                  ></div>
                                  <div
                                    className="bg-blue-500 h-3 rounded-r-lg"
                                    style={{ width: `${remotePercentage}%` }}
                                  ></div>
                                </div>
                              </td>
                              <td>
                                <button
                                  className="text-sm mr-2"
                                  onClick={() =>
                                    closeChannel(
                                      channel.id,
                                      channel.remotePubkey,
                                      channel.active
                                    )
                                  }
                                >
                                  ❌
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const formatAmount = (amount: number, decimals = 1) => {
  amount /= 1000; //msat to sat
  let i = 0;
  for (i; amount >= 1000; i++) {
    amount /= 1000;
  }
  return amount.toFixed(i > 0 ? decimals : 0) + ["", "k", "M", "G"][i];
};
