import {
  getGetTechnicianAccessHistoryQueryKey,
  getListTechniciansQueryKey,
  useGetTechnicianAccessHistory,
  useListTechnicians,
  useUpdateTechnicianAccess,
  type TechnicianAccount,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Link } from "wouter";

function displayName(account: TechnicianAccount): string {
  const fullName = [account.firstName, account.lastName].filter(Boolean).join(" ");
  return fullName || account.email || `Account ${account.id.slice(0, 8)}`;
}

function AccessHistory({ technicianId }: { technicianId: string }) {
  const historyQuery = useGetTechnicianAccessHistory(technicianId);

  if (historyQuery.isLoading) {
    return (
      <div className="border-t border-[#e4e5df] bg-[#f7f6f1] px-5 py-4 text-sm text-[#718087]">
        Loading access history…
      </div>
    );
  }

  if (historyQuery.isError) {
    return (
      <div className="flex flex-col gap-3 border-t border-[#e4e5df] bg-[#f7f6f1] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p role="alert" className="text-sm text-[#9d5045]">
          Access history could not be loaded.
        </p>
        <button
          type="button"
          onClick={() => void historyQuery.refetch()}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-[#d8ddd8] px-3 py-2 text-xs font-semibold text-[#52636a]"
        >
          <RefreshCw size={13} /> Try again
        </button>
      </div>
    );
  }

  const events = historyQuery.data?.events ?? [];
  if (events.length === 0) {
    return (
      <p className="border-t border-[#e4e5df] bg-[#f7f6f1] px-5 py-4 text-sm text-[#778287]">
        No technician access decisions have been recorded.
      </p>
    );
  }

  return (
    <ol
      data-testid={`access-history-${technicianId}`}
      className="divide-y divide-[#e4e5df] border-t border-[#e4e5df] bg-[#f7f6f1]"
    >
      {events.map((event) => {
        const changedByName = [
          event.changedBy.firstName,
          event.changedBy.lastName,
        ]
          .filter(Boolean)
          .join(" ");
        const changedByLabel =
          [changedByName, event.changedBy.email].filter(Boolean).join(" · ") ||
          `Administrator ${event.changedBy.id.slice(0, 8)}`;

        return (
          <li key={event.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-center">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a9291]">
                Previous state
              </div>
              <div className="mt-1 text-sm font-medium text-[#35474e]">
                {event.previousIsTechnician ? "Approved" : "Pending"}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a9291]">
                New state
              </div>
              <div className="mt-1 text-sm font-medium text-[#35474e]">
                {event.isTechnician ? "Approved" : "Access revoked"}
              </div>
            </div>
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a9291]">
                Administrator
              </div>
              <div className="mt-1 truncate text-sm text-[#52636a]">
                {changedByLabel}
              </div>
            </div>
            <time
              dateTime={event.changedAt}
              className="text-xs text-[#778287] sm:text-right"
            >
              {new Date(event.changedAt).toLocaleString()}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

function TechnicianAccountRow({
  account,
  approvedState,
  disabled,
  onToggle,
}: {
  account: TechnicianAccount;
  approvedState: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${approvedState ? "bg-[#e8f0e9] text-[#577668]" : "bg-[#f4e9da] text-[#a66f42]"}`}>
            <UserRound size={17} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[#35474e]">
              {displayName(account)}
            </div>
            <div className="mt-1 truncate text-xs text-[#7b8589]">
              {account.email ?? "Email unavailable"} · Joined{" "}
              {new Date(account.createdAt).toLocaleDateString()}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            aria-expanded={showHistory}
            aria-controls={`access-history-${account.id}`}
            data-testid={`button-access-history-${account.id}`}
            onClick={() => setShowHistory((open) => !open)}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#d8ddd8] px-3 py-2.5 text-xs font-semibold text-[#52636a] transition hover:bg-[#f5f3ed]"
          >
            <History size={14} />
            {showHistory ? "Hide history" : "Access history"}
            {showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            type="button"
            data-testid={`button-technician-access-${account.id}`}
            disabled={disabled}
            onClick={onToggle}
            className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-60 ${approvedState ? "border border-[#d8ddd8] text-[#52636a] hover:bg-[#f5f3ed]" : "bg-[#263740] text-white hover:bg-[#344b54]"}`}
          >
            {approvedState ? "Revoke access" : <><Check size={14} /> Approve technician</>}
          </button>
        </div>
      </div>
      {showHistory && (
        <div id={`access-history-${account.id}`} className="-mx-5 mt-4">
          <AccessHistory technicianId={account.id} />
        </div>
      )}
    </li>
  );
}

export function AdminTechnicians() {
  const queryClient = useQueryClient();
  const [emailFilter, setEmailFilter] = useState("");
  const accountsQuery = useListTechnicians({
    query: {
      queryKey: getListTechniciansQueryKey(),
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  });
  const updateAccess = useUpdateTechnicianAccess({
    mutation: {
      onSuccess: async (_data, variables) => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getListTechniciansQueryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: getGetTechnicianAccessHistoryQueryKey(variables.userId),
          }),
        ]);
      },
    },
  });
  const accounts = accountsQuery.data?.accounts ?? [];
  const normalizedFilter = emailFilter.trim().toLowerCase();
  const matchingAccounts = accounts.filter((account) =>
    !normalizedFilter ||
    [account.email, displayName(account)]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedFilter)),
  );
  const pending = matchingAccounts.filter((account) => !account.isTechnician);
  const approved = matchingAccounts.filter((account) => account.isTechnician);

  function toggleAccess(account: TechnicianAccount) {
    updateAccess.mutate({
      userId: account.id,
      data: { isTechnician: !account.isTechnician },
    });
  }

  function accountRows(rows: TechnicianAccount[], approvedState: boolean) {
    if (!rows.length) {
      return (
        <p className="px-5 py-8 text-sm text-[#778287]">
          {approvedState ? "No approved technicians yet." : "There are no accounts waiting for review."}
        </p>
      );
    }
    return (
      <ul className="divide-y divide-[#e4e5df]">
        {rows.map((account) => (
        <TechnicianAccountRow
          key={account.id}
          account={account}
          approvedState={approvedState}
          disabled={updateAccess.isPending}
          onToggle={() => toggleAccess(account)}
        />
        ))}
      </ul>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-[#f5f3ed] text-[#263740]">
      <header className="flex min-h-[76px] items-center justify-between border-b border-[#d9ddd9] px-5 sm:px-10">
        <div>
          <div className="text-sm font-semibold tracking-[0.13em]">ASC SPATIAL</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[#748088]">Workspace administration</div>
        </div>
        <Link href="/workspace" className="inline-flex items-center gap-2 text-sm font-medium text-[#52636a] hover:text-[#263740]">
          <ArrowLeft size={15} /> Workspace
        </Link>
      </header>
      <section className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <div className="mb-8 flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#e8eeea] text-[#577668]">
            <ShieldCheck size={23} />
          </span>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[#9c7958]">Account access</p>
            <h1 className="mt-1 font-serif text-3xl sm:text-4xl">Technician review</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e7a7f]">
              Approve accounts that need field access or revoke access that is no longer required. Changes take effect on the next account check.
            </p>
          </div>
        </div>

        <label className="mb-3 block">
          <span className="mb-2 block text-xs font-semibold text-[#52636a]">
            Find a registered account by email
          </span>
          <span className="flex items-center gap-2 rounded-xl border border-[#d9ddd9] bg-[#fbfaf6] px-3.5">
            <Search size={16} className="shrink-0 text-[#778287]" />
            <input
              type="search"
              aria-label="Find a registered account by email"
              data-testid="technician-email-filter"
              value={emailFilter}
              onChange={(event) => setEmailFilter(event.target.value)}
              placeholder="name@company.com"
              className="h-11 w-full bg-transparent text-sm text-[#263740] outline-none placeholder:text-[#8b9598]"
            />
          </span>
        </label>
        <p className="mb-5 text-xs leading-5 text-[#748088]">
          Only registered accounts appear here. Administrator appointments are
          controlled separately by the workspace owner.
        </p>

        {updateAccess.isError && (
          <div role="alert" className="mb-5 rounded-xl border border-[#ead0c9] bg-[#fbf0ec] px-4 py-3 text-sm text-[#9d5045]">
            Access could not be updated. Refresh the account list and try again.
          </div>
        )}
        {accountsQuery.isLoading ? (
          <div className="rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6] p-8 text-sm text-[#718087]">Loading workspace accounts…</div>
        ) : accountsQuery.isError ? (
          <div className="rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6] p-8">
            <p role="alert" className="text-sm text-[#9d5045]">Workspace accounts could not be loaded.</p>
            <button onClick={() => void accountsQuery.refetch()} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[#d8ddd8] px-3 py-2 text-xs font-semibold text-[#52636a]">
              <RefreshCw size={13} /> Try again
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {normalizedFilter && matchingAccounts.length === 0 ? (
              <div className="rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6] p-6 text-sm text-[#718087]">
                No registered account matches that email. The user must create
                an account before technician access can be assigned.
              </div>
            ) : (
              <>
                <section className="overflow-hidden rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6]">
                  <div className="flex items-center justify-between border-b border-[#e4e5df] px-5 py-4">
                    <h2 className="text-sm font-semibold">Pending approval</h2>
                    <span className="rounded-full bg-[#f4e9da] px-2.5 py-1 font-mono text-[10px] text-[#956b45]">{pending.length}</span>
                  </div>
                  {accountRows(pending, false)}
                </section>
                <section className="overflow-hidden rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6]">
                  <div className="flex items-center justify-between border-b border-[#e4e5df] px-5 py-4">
                    <h2 className="text-sm font-semibold">Approved technicians</h2>
                    <span className="rounded-full bg-[#e8f0e9] px-2.5 py-1 font-mono text-[10px] text-[#577668]">{approved.length}</span>
                  </div>
                  {accountRows(approved, true)}
                </section>
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
