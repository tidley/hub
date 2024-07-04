import { format } from "date-fns";
import { CalendarIcon, PlusCircle, XIcon } from "lucide-react";
import React, { useEffect, useState } from "react";
import Scopes from "src/components/Scopes";
import { Button } from "src/components/ui/button";
import { Calendar } from "src/components/ui/calendar";
import { Input } from "src/components/ui/input";
import { Label } from "src/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "src/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "src/components/ui/select";
import { cn } from "src/lib/utils";
import {
  AppPermissions,
  BudgetRenewalType,
  NIP_47_PAY_INVOICE_METHOD,
  Scope,
  WalletCapabilities,
  budgetOptions,
  expiryOptions,
  validBudgetRenewals,
} from "src/types";

const daysFromNow = (date?: Date) =>
  date
    ? Math.ceil((new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

interface PermissionsProps {
  capabilities: WalletCapabilities;
  initialPermissions: AppPermissions;
  onPermissionsChange: (permissions: AppPermissions) => void;
  canEditPermissions: boolean;
  budgetUsage?: number;
}

const Permissions: React.FC<PermissionsProps> = ({
  capabilities,
  initialPermissions,
  onPermissionsChange,
  canEditPermissions,
  budgetUsage,
}) => {
  // TODO: EDITABLE LOGIC
  const [permissions, setPermissions] = React.useState(initialPermissions);

  // TODO: set expiry when set to non expiryType value like 24 days for example
  const [expiryDays, setExpiryDays] = useState(
    daysFromNow(permissions.expiresAt)
  );
  const [budgetOption, setBudgetOption] = useState(!!permissions.maxAmount);
  const [customBudget, setCustomBudget] = useState(!!permissions.maxAmount);
  const [expireOption, setExpireOption] = useState(!!permissions.expiresAt);
  const [customExpiry, setCustomExpiry] = useState(!!permissions.expiresAt);

  useEffect(() => {
    setPermissions(initialPermissions);
  }, [initialPermissions]);

  const handlePermissionsChange = (
    changedPermissions: Partial<AppPermissions>
  ) => {
    const updatedPermissions = { ...permissions, ...changedPermissions };
    setPermissions(updatedPermissions);
    onPermissionsChange(updatedPermissions);
  };

  const handleScopeChange = (scopes: Set<Scope>) => {
    // TODO: what if edit is not set (see prev diff)
    // TODO: what if we set pay_invoice scope again, what would be the value of budgetRenewal
    handlePermissionsChange({ scopes });
  };

  const handleBudgetMaxAmountChange = (amount: string) => {
    handlePermissionsChange({ maxAmount: amount });
  };

  const handleBudgetRenewalChange = (value: string) => {
    handlePermissionsChange({ budgetRenewal: value as BudgetRenewalType });
  };

  const handleExpiryDaysChange = (expiryDays: number) => {
    setExpiryDays(expiryDays);
    if (!expiryDays) {
      handlePermissionsChange({ expiresAt: undefined });
      return;
    }
    const currentDate = new Date();
    currentDate.setDate(currentDate.getDate() + expiryDays);
    currentDate.setHours(23, 59, 59, 0);
    handlePermissionsChange({ expiresAt: currentDate });
  };

  return (
    <div>
      <Scopes
        capabilities={capabilities}
        scopes={permissions.scopes}
        onScopeChange={handleScopeChange}
      />

      {capabilities.scopes.includes(NIP_47_PAY_INVOICE_METHOD) &&
        permissions.scopes.has(NIP_47_PAY_INVOICE_METHOD) && (
          <>
            {!budgetOption && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setBudgetOption(true)}
                className="mb-4 mr-4"
              >
                <PlusCircle className="w-4 h-4 mr-2" />
                Set budget renewal
              </Button>
            )}
            {budgetOption && (
              <>
                <p className="font-medium text-sm mb-2">Budget Renewal</p>
                <div className="flex gap-2 items-center text-muted-foreground mb-4 text-sm capitalize">
                  <Select
                    value={permissions.budgetRenewal}
                    onValueChange={(value) =>
                      handleBudgetRenewalChange(value as BudgetRenewalType)
                    }
                  >
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder={permissions.budgetRenewal} />
                    </SelectTrigger>
                    <SelectContent>
                      {validBudgetRenewals.map((renewalOption) => (
                        <SelectItem
                          key={renewalOption || "never"}
                          value={renewalOption || "never"}
                        >
                          {renewalOption
                            ? renewalOption.charAt(0).toUpperCase() +
                              renewalOption.slice(1)
                            : "Never"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                    <XIcon
                      className="cursor-pointer w-4 text-muted-foreground"
                      onClick={() => handleBudgetRenewalChange("never")}
                    />
                  </Select>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs mb-4">
                  {Object.keys(budgetOptions).map((budget) => {
                    return (
                      // replace with something else and then remove dark prefixes
                      <div
                        key={budget}
                        onClick={() => {
                          setCustomBudget(false);
                          handleBudgetMaxAmountChange(
                            budgetOptions[budget].toString()
                          );
                        }}
                        className={cn(
                          "cursor-pointer rounded text-nowrap border-2 text-center p-4 dark:text-white",
                          !customBudget &&
                            (permissions.maxAmount === ""
                              ? 100000
                              : +permissions.maxAmount) == budgetOptions[budget]
                            ? "border-primary"
                            : "border-muted"
                        )}
                      >
                        {`${budget} ${budgetOptions[budget] ? " sats" : ""}`}
                      </div>
                    );
                  })}
                  <div
                    onClick={() => {
                      setCustomBudget(true);
                      handleBudgetMaxAmountChange("");
                    }}
                    className={cn(
                      "cursor-pointer rounded border-2 text-center p-4 dark:text-white",
                      customBudget ? "border-primary" : "border-muted"
                    )}
                  >
                    Custom...
                  </div>
                </div>
                {customBudget && (
                  <div className="w-full mb-6">
                    <Label htmlFor="budget" className="block mb-2">
                      Custom budget amount (sats)
                    </Label>
                    <Input
                      id="budget"
                      name="budget"
                      type="number"
                      required
                      min={1}
                      value={permissions.maxAmount}
                      onChange={(e) => {
                        handleBudgetMaxAmountChange(e.target.value.trim());
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}

      {!expireOption && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setExpireOption(true)}
          className="mb-6"
        >
          <PlusCircle className="w-4 h-4 mr-2" />
          Set expiration time
        </Button>
      )}

      {expireOption && (
        <div className="mb-6">
          <p className="font-medium text-sm mb-2">Connection expiration</p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs mb-4">
            {Object.keys(expiryOptions).map((expiry) => {
              return (
                <div
                  key={expiry}
                  onClick={() => {
                    setCustomExpiry(false);
                    handleExpiryDaysChange(expiryOptions[expiry]);
                  }}
                  className={cn(
                    "cursor-pointer rounded text-nowrap border-2 text-center p-4 dark:text-white",
                    !customExpiry && expiryDays == expiryOptions[expiry]
                      ? "border-primary"
                      : "border-muted"
                  )}
                >
                  {expiry}
                </div>
              );
            })}
            <Popover>
              <PopoverTrigger asChild>
                <div
                  onClick={() => {}}
                  className={cn(
                    "flex items-center justify-center md:col-span-2 cursor-pointer rounded text-nowrap border-2 text-center px-3 py-4 dark:text-white",
                    customExpiry ? "border-primary" : "border-muted"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {customExpiry && permissions.expiresAt
                      ? format(permissions.expiresAt, "PPP")
                      : "Custom..."}
                  </span>
                </div>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={permissions.expiresAt}
                  onSelect={(date?: Date) => {
                    if (daysFromNow(date) == 0) {
                      return;
                    }
                    setCustomExpiry(true);
                    handleExpiryDaysChange(daysFromNow(date));
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
    </div>
  );
};

export default Permissions;
