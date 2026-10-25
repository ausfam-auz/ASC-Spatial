import { useEffect, useRef, useMemo, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn as ClerkSignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  getHealthCheckQueryKey,
  getListScansQueryKey,
  useHealthCheck,
  useListScans,
  useUploadScan,
  useGetAccount,
} from '@workspace/api-client-react';
import type { AuthUser, ScanUploadRequest } from '@workspace/api-client-react';
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  FileBox,
  FileUp,
  LogOut,
  Radio,
  RefreshCw,
  ShieldCheck,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { Route, Switch, Redirect, Link, useLocation, Router as WouterRouter } from 'wouter';
import logoSrc from '@/assets/asc-spatial-logo.jpg';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { AdminTechnicians } from '@/components/AdminTechnicians';

const queryClient = new QueryClient();
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
// Replit injects this in production; it is intentionally empty in development.
// Keep unconditional: a hardcoded fallback would break the dev Clerk instance.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: new URL(logoSrc, window.location.origin).toString(),
  },
  variables: {
    colorPrimary: "#263740", colorForeground: "#263740",
    colorMutedForeground: "#68747a", colorDanger: "#a74f43",
    colorBackground: "#fbfaf6", colorInput: "#fffefa",
    colorInputForeground: "#263740", colorNeutral: "#52636a",
    fontFamily: "'DM Sans', sans-serif", borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#fbfaf6] rounded-2xl w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#263740]", headerSubtitle: "text-[#68747a]",
    socialButtonsBlockButtonText: "text-[#263740]", formFieldLabel: "text-[#263740]",
    footerActionLink: "text-[#82562f]", footerActionText: "text-[#68747a]",
    dividerText: "text-[#68747a]", identityPreviewEditButton: "text-[#82562f]",
    formFieldSuccessText: "text-[#46665e]", alertText: "text-[#a74f43]",
    logoBox: "mb-5", logoImage: "h-14", socialButtonsBlockButton: "border-[#d9ddd9]",
    formButtonPrimary: "bg-[#263740] text-white", formFieldInput: "bg-[#fffefa] text-[#263740]",
    footerAction: "border-t border-[#d9ddd9]", dividerLine: "bg-[#d9ddd9]",
    alert: "bg-[#fbf0ec]", otpCodeFieldInput: "text-[#263740]", formFieldRow: "mb-4", main: "gap-5",
  },
};
const MAX_FILE_BYTES = 100 * 1024 * 1024;

function localDateTimeValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'Something interrupted the request. Try again when the connection is stable.';
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${small ? '' : 'mb-1'}`}>
      <img
        src={logoSrc}
        alt=""
        className="h-10 w-10 rounded-xl object-cover ring-1 ring-[#263740]/10"
      />
      <div>
        <div className="font-semibold tracking-[0.13em] text-[#263740]">ASC SPATIAL</div>
        <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-[#748088]">Field workspace</div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <main className="min-h-[100dvh] bg-[#f5f3ed]">
      <header className="flex h-[76px] items-center border-b border-[#d9ddd9] px-6 md:px-10">
        <BrandMark />
      </header>
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-9 h-7 w-52 animate-pulse rounded bg-[#e3e3dc]" />
        <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
          <div className="h-[380px] animate-pulse rounded-2xl bg-[#e9e8e1]" />
          <div className="h-[380px] animate-pulse rounded-2xl bg-[#e9e8e1]" />
        </div>
      </div>
    </main>
  );
}

function SignIn({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="workspace-grid relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#f5f3ed]">
      <header className="relative z-10 px-6 py-6 md:px-12">
        <BrandMark />
      </header>
      <div className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-14 px-6 pb-16 pt-6 lg:grid-cols-[1.05fr_.95fr] lg:px-12">
        <section className="max-w-xl">
          <img
            src={logoSrc}
            alt="ASC Spatial logo"
            className="mb-7 h-24 w-24 rounded-[1.35rem] object-cover shadow-[0_12px_35px_rgba(12,42,63,.18)] ring-1 ring-[#263740]/10"
          />
          <div className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#99714d]">
            <span className="h-px w-8 bg-[#c98a52]" /> Vessel & asset intelligence
          </div>
          <h1 className="font-serif text-[clamp(3.6rem,7vw,6.9rem)] leading-[.91] tracking-[-0.035em] text-[#263740]">
            Every point<br />has a <em className="text-[#bd7842]">place.</em>
          </h1>
          <p className="mt-7 max-w-md text-base leading-7 text-[#68747a]">
            A dependable field workspace for bringing your inspection scans ashore, intact and accounted for.
          </p>
          <div className="mt-12 flex items-center gap-4 border-t border-[#d9ddd9] pt-5 text-xs text-[#738087]">
            <div className="flex -space-x-1">
              {[0, 1, 2].map((item) => <span key={item} className="h-2 w-2 rounded-full border border-[#f5f3ed] bg-[#718c84]" />)}
            </div>
            <span>Built for the work between ship and shore</span>
          </div>
        </section>
        <section className="relative">
          <div className="absolute -inset-5 rounded-[2rem] bg-[#e6e6de]/60 blur-2xl" />
          <div className="relative rounded-[1.5rem] border border-[#d9ddd9] bg-[#fbfaf6] p-7 shadow-[0_18px_55px_rgba(38,55,64,.08)] md:p-10">
            <div className="mb-10 flex items-center justify-between">
              <img
                src={logoSrc}
                alt="ASC Spatial logo"
                className="h-14 w-14 rounded-2xl object-cover ring-1 ring-[#263740]/10"
              />
              <span className="font-mono text-[10px] uppercase tracking-[.17em] text-[#87918e]">Secure access · 01</span>
            </div>
            <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[#ad7447]">Field operations portal</p>
            <h2 className="mt-2 font-serif text-4xl text-[#263740]">Sign in to continue</h2>
            <p className="mt-3 text-sm leading-6 text-[#6e7a7f]">Use your approved technician account to access your scan workspace.</p>
            <button onClick={onLogin} data-testid="button-login" className="mt-8 flex w-full items-center justify-between rounded-xl bg-[#263740] px-5 py-4 text-sm font-semibold text-[#faf8f1] transition hover:bg-[#344a54] focus:outline-none focus:ring-2 focus:ring-[#c98a52] focus:ring-offset-2">
              <span className="flex items-center gap-3"><LogOut size={17} className="rotate-180" /> Continue with secure sign-in</span>
              <ChevronRight size={18} />
            </button>
            <div className="mt-6 flex items-start gap-3 border-t border-[#e3e4df] pt-5 text-xs leading-5 text-[#7b8589]">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#68877c]" />
              <span>Your session is protected. Only approved field technicians can upload or view scans.</span>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-center gap-2 text-[11px] text-[#8a9293]"><Radio size={13} /> Workspace access is tied to your technician identity</div>
        </section>
      </div>
      <div className="pointer-events-none absolute -bottom-36 -right-20 h-[440px] w-[440px] rounded-full border border-[#d4d8d2] opacity-70" />
      <div className="pointer-events-none absolute -bottom-24 -right-8 h-[320px] w-[320px] rounded-full border border-[#d4d8d2] opacity-70" />
    </main>
  );
}

function AccessPending({ onLogout }: { onLogout: () => void }) {
  return (
    <main className="workspace-grid flex min-h-[100dvh] flex-col bg-[#f5f3ed]">
      <header className="flex h-[76px] items-center justify-between border-b border-[#d9ddd9] px-6 md:px-10">
        <BrandMark />
        <button onClick={onLogout} data-testid="button-logout" className="flex items-center gap-2 text-sm text-[#68747a] hover:text-[#263740]"><LogOut size={16} /> Log out</button>
      </header>
      <div className="mx-auto flex w-full max-w-4xl flex-1 items-center px-6 py-12">
        <section className="w-full rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6] p-8 shadow-[0_16px_48px_rgba(38,55,64,.05)] md:p-12">
          <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f4e9da] text-[#b87943]"><ShieldCheck size={27} /></div>
          <p className="font-mono text-[10px] uppercase tracking-[.2em] text-[#aa764c]">Access status / pending</p>
          <h1 className="mt-3 font-serif text-4xl text-[#263740]">Technician approval required</h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-[#6f7a7e]">Your account is signed in, but it is not yet approved for field technician access. Scan uploads and recent scan records are available to approved technicians only.</p>
          <div className="mt-9 flex flex-wrap items-center justify-between gap-4 border-t border-[#e2e3de] pt-6">
            <span className="flex items-center gap-2 text-xs text-[#818b8e]"><span className="h-2 w-2 rounded-full bg-[#d08b4d]" /> Approval status is controlled by your workspace administrator.</span>
            <button onClick={onLogout} data-testid="button-logout" className="flex items-center gap-2 rounded-lg border border-[#d8ddd8] px-4 py-2.5 text-sm font-semibold text-[#43535a] hover:bg-[#f2f1eb]"><LogOut size={15} /> Log out</button>
          </div>
        </section>
      </div>
    </main>
  );
}

function ScanWorkspace({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const queryClient = useQueryClient();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000, retry: 1 } });
  const scansQuery = useListScans({ query: { queryKey: getListScansQueryKey(), retry: 1 } });
  const uploadScan = useUploadScan({
    mutation: {
      onSuccess: async (record) => {
        setSuccessId(record.id);
        setFile(null);
        const input = document.getElementById('scan-file-input') as HTMLInputElement | null;
        if (input) input.value = '';
        await queryClient.invalidateQueries({ queryKey: getListScansQueryKey() });
      },
    },
  });
  const [moduleType, setModuleType] = useState<'DeckOps' | 'ToolingAudit'>('DeckOps');
  const [timestamp, setTimestamp] = useState(localDateTimeValue);
  const [assetName, setAssetName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [successId, setSuccessId] = useState('');
  const [dragging, setDragging] = useState(false);
  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Technician';
  const initials = userName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const scans = useMemo(() => scansQuery.data?.scans ?? [], [scansQuery.data?.scans]);
  const online = health.data?.status?.toLowerCase() === 'ok' || health.data?.status?.toLowerCase() === 'healthy';
  const isPending = uploadScan.isPending;

  function acceptFile(selected?: File) {
    if (!selected) return;
    const ext = selected.name.split('.').pop()?.toLowerCase();
    if (ext !== 'ply' && ext !== 'obj') {
      setFile(null);
      setFileError('Unsupported file type. Choose a .ply or .obj scan.');
      return;
    }
    if (selected.size > MAX_FILE_BYTES) {
      setFile(null);
      setFileError('This file exceeds the 100 MiB upload limit.');
      return;
    }
    setFile(selected);
    setFileError('');
    setSuccessId('');
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0]);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !assetName.trim() || !timestamp) return;
    const payload: ScanUploadRequest = {
      moduleType,
      technicianId: user.id,
      timestamp: new Date(timestamp).toISOString(),
      vesselAssetName: assetName.trim(),
      file,
    };
    setSuccessId('');
    uploadScan.mutate({ data: payload });
  }

  const uploadReady = !!file && !!assetName.trim() && !!timestamp && !isPending;

  return (
    <main className="min-h-[100dvh] bg-[#f5f3ed] text-[#263740]">
      <header className="border-b border-[#d9ddd9] bg-[#f8f7f2]">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-5 md:px-9">
          <BrandMark />
          <div className="flex items-center gap-4">
            <div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium sm:flex ${online ? 'border-[#cedbd3] bg-[#edf3ee] text-[#55786b]' : health.isError ? 'border-[#e8d3c4] bg-[#f7eee5] text-[#9d714a]' : 'border-[#d9ddd9] bg-[#f2f1eb] text-[#748087]'}`}>
              {online ? <Wifi size={14} /> : health.isError ? <WifiOff size={14} /> : <Radio size={14} />}
              {online ? 'Service connected' : health.isError ? 'Connection unavailable' : 'Checking connection'}
            </div>
            <div className="hidden h-7 w-px bg-[#d9ddd9] sm:block" />
            <div className="flex items-center gap-2.5">
              {user.profileImageUrl ? <img src={user.profileImageUrl} alt="" className="h-8 w-8 rounded-full object-cover" /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#dfe7e1] text-[11px] font-semibold text-[#46665e]">{initials}</span>}
              <div className="hidden leading-tight sm:block">
                <div data-testid="text-technician-name" className="text-xs font-semibold text-[#35474e]">{userName}</div>
                <div className="mt-1 text-[10px] text-[#818b8e]">Field technician</div>
              </div>
            </div>
            <button onClick={onLogout} data-testid="button-logout" aria-label="Log out" title="Log out" className="ml-1 rounded-lg p-2 text-[#738087] hover:bg-[#ebece6] hover:text-[#263740]"><LogOut size={17} /></button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-5 pb-12 pt-8 md:px-9 md:pt-11">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.19em] text-[#9c7958]"><span className="h-px w-5 bg-[#c98a52]" /> Field operations / scan intake</div>
            <h1 className="font-serif text-4xl leading-none tracking-[-.02em] text-[#263740] md:text-5xl">Scan workspace</h1>
            <p className="mt-3 text-sm text-[#748087]">Upload inspection data and keep your field record in sync.</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-[#d9ddd9] bg-[#faf9f5] px-3 py-2 text-[11px] text-[#768289]">
            <span className="font-mono text-[#a27148]">TECH ID</span>
            <span className="font-mono text-[#52636a]">{user.id}</span>
          </div>
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.12fr)_minmax(400px,.88fr)]">
          <section className="overflow-hidden rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6] shadow-[0_10px_32px_rgba(38,55,64,.035)]">
            <div className="flex items-center justify-between border-b border-[#e4e5df] px-6 py-5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-[#a17049]">01 / Intake</div>
                <h2 className="mt-1 text-lg font-semibold tracking-[-.02em]">Upload inspection scan</h2>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f2ece3] text-[#b77d4a]"><FileUp size={18} /></div>
            </div>
            <form onSubmit={submit} className="space-y-5 p-6">
              <div>
                <label htmlFor="module-type" className="mb-2 block text-xs font-semibold text-[#4b5b61]">Inspection module</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['DeckOps', 'ToolingAudit'] as const).map((module) => (
                    <button type="button" key={module} onClick={() => setModuleType(module)} data-testid={`button-module-${module.toLowerCase()}`} className={`flex min-h-[48px] items-center justify-between rounded-lg border px-3.5 text-left text-sm transition ${moduleType === module ? 'border-[#b77f4e] bg-[#f6eee3] font-semibold text-[#6d4c31]' : 'border-[#dfe2dc] bg-[#faf9f5] text-[#6c787c] hover:border-[#b8c2bd]'}`}>
                      {module === 'DeckOps' ? 'DeckOps' : 'ToolingAudit'}
                      {moduleType === module && <Check size={15} />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="vessel-asset" className="mb-2 block text-xs font-semibold text-[#4b5b61]">Vessel / asset name</label>
                  <input id="vessel-asset" data-testid="input-vessel-asset" value={assetName} onChange={(event) => setAssetName(event.target.value)} maxLength={255} required placeholder="e.g. MV Northstar · Main deck" className="h-11 w-full rounded-lg border border-[#d9ddd9] bg-[#fffefa] px-3.5 text-sm text-[#263740] outline-none placeholder:text-[#a5ada9] focus:border-[#bf895c] focus:ring-2 focus:ring-[#bf895c]/15" />
                </div>
                <div>
                  <label htmlFor="inspection-time" className="mb-2 block text-xs font-semibold text-[#4b5b61]">Inspection timestamp</label>
                  <input id="inspection-time" data-testid="input-inspection-timestamp" type="datetime-local" value={timestamp} onChange={(event) => setTimestamp(event.target.value)} required className="h-11 w-full rounded-lg border border-[#d9ddd9] bg-[#fffefa] px-3 text-sm text-[#4d5d64] outline-none focus:border-[#bf895c] focus:ring-2 focus:ring-[#bf895c]/15" />
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label htmlFor="scan-file-input" className="text-xs font-semibold text-[#4b5b61]">Scan file</label>
                  <span className="font-mono text-[10px] text-[#919a9a]">.PLY / .OBJ · MAX 100 MiB</span>
                </div>
                <label onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} htmlFor="scan-file-input" data-testid="dropzone-scan-file" className={`group flex min-h-[132px] cursor-pointer items-center justify-center rounded-xl border border-dashed px-5 py-5 text-center transition ${dragging ? 'border-[#b77f4e] bg-[#f6eee3]' : file ? 'border-[#9eb6a8] bg-[#f0f5f0]' : 'border-[#cfd6d1] bg-[#f7f7f2] hover:border-[#b77f4e] hover:bg-[#f8f4ec]'}`}>
                  <input id="scan-file-input" data-testid="input-scan-file" type="file" accept=".ply,.obj" className="sr-only" onChange={onFileChange} />
                  {file ? (
                    <div className="flex w-full items-center gap-3 text-left">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#dce9df] text-[#527665]"><FileBox size={21} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-[#40574f]">{file.name}</div>
                        <div className="mt-1 font-mono text-[10px] text-[#7a8b83]">{formatSize(file.size)} · Ready to upload</div>
                      </div>
                      <button type="button" aria-label="Remove selected scan" data-testid="button-remove-scan-file" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setFile(null); setFileError(''); }} className="rounded-md p-2 text-[#758780] hover:bg-[#e0e9e1]"><X size={16} /></button>
                    </div>
                  ) : (
                    <div>
                      <span className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-[#dfe2dc] bg-[#fffefa] text-[#a87549]"><Upload size={17} /></span>
                      <div className="text-sm font-medium text-[#52636a]">Drop scan file here or <span className="text-[#a66f42] underline underline-offset-2">browse</span></div>
                      <div className="mt-1 text-[11px] text-[#929b9b]">Large scans may take time on a field connection</div>
                    </div>
                  )}
                </label>
                {fileError && <p data-testid="status-file-error" className="mt-2 flex items-center gap-1.5 text-xs text-[#a74f43]"><AlertCircle size={14} />{fileError}</p>}
              </div>

              {uploadScan.isError && (
                <div data-testid="status-upload-error" role="alert" className="flex items-start gap-2.5 rounded-lg border border-[#ead0c9] bg-[#fbf0ec] px-3.5 py-3 text-xs leading-5 text-[#9d5045]">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" /><span>Upload did not complete. {errorMessage(uploadScan.error)} Your source file is still selected; retry when connectivity allows.</span>
                </div>
              )}
              {successId && (
                <div data-testid="status-upload-success" role="status" className="flex items-start gap-2.5 rounded-lg border border-[#cdded2] bg-[#eef5ef] px-3.5 py-3 text-xs leading-5 text-[#4c7160]">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" /><span>Scan received. Record ID <strong className="font-mono">{successId}</strong></span>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e6e7e1] pt-5">
                <div className="flex items-center gap-2 text-[11px] text-[#899393]"><ShieldCheck size={14} className="text-[#668477]" /> Technician ID assigned from your account</div>
                <button type="submit" data-testid="button-submit-upload" disabled={!uploadReady} className="flex min-w-[160px] items-center justify-center gap-2 rounded-lg bg-[#263740] px-5 py-3 text-sm font-semibold text-[#faf8f1] transition hover:bg-[#344b54] disabled:cursor-not-allowed disabled:bg-[#b6bfbc]">
                  {isPending ? <><RefreshCw size={15} className="animate-spin" /> Uploading…</> : <><ArrowDownToLine size={16} /> Upload scan</>}
                </button>
              </div>
            </form>
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#d9ddd9] bg-[#fbfaf6] shadow-[0_10px_32px_rgba(38,55,64,.035)]">
            <div className="flex items-center justify-between border-b border-[#e4e5df] px-6 py-5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-[#a17049]">02 / Records</div>
                <h2 className="mt-1 text-lg font-semibold tracking-[-.02em]">Recent scans</h2>
              </div>
              <span className="rounded-full bg-[#edf0eb] px-2.5 py-1 font-mono text-[10px] text-[#667971]">{scans.length.toString().padStart(2, '0')} records</span>
            </div>
            <div className="min-h-[300px]">
              {scansQuery.isLoading ? (
                <div data-testid="state-scans-loading" className="space-y-3 p-6">
                  {[0, 1, 2, 3].map((row) => <div key={row} className="h-[61px] animate-pulse rounded-lg bg-[#efefe9]" />)}
                </div>
              ) : scansQuery.isError ? (
                <div data-testid="state-scans-error" className="flex min-h-[300px] flex-col items-center justify-center px-7 text-center">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#f8e9e3] text-[#a75a49]"><WifiOff size={19} /></div>
                  <h3 className="text-sm font-semibold text-[#42535a]">Records are temporarily unavailable</h3>
                  <p className="mt-2 max-w-xs text-xs leading-5 text-[#849092]">{errorMessage(scansQuery.error)}</p>
                  <button onClick={() => scansQuery.refetch()} data-testid="button-retry-scans" className="mt-4 flex items-center gap-2 rounded-lg border border-[#d8ddd8] px-3.5 py-2 text-xs font-semibold text-[#52636a] hover:bg-[#f1f1eb]"><RefreshCw size={13} /> Retry</button>
                </div>
              ) : scans.length === 0 ? (
                <div data-testid="state-scans-empty" className="flex min-h-[300px] flex-col items-center justify-center px-7 text-center">
                  <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#dfe3dc] bg-[#f4f4ee] text-[#76877f]"><FileBox size={27} /><span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#fbfaf6] bg-[#d08b4d]" /></div>
                  <h3 className="font-serif text-2xl text-[#3f5158]">Your field log starts here</h3>
                  <p className="mt-2 max-w-xs text-xs leading-5 text-[#879191]">Completed scan uploads will appear here with their inspection details.</p>
                </div>
              ) : (
                <div className="divide-y divide-[#e9e9e3]">
                  {scans.map((scan, index) => (
                    <div key={scan.id} data-testid={`row-scan-${scan.id}`} className="scan-row flex items-center gap-3.5 px-5 py-4 transition hover:bg-[#f7f6f0]" style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}>
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${scan.moduleType === 'DeckOps' ? 'bg-[#eaf0eb] text-[#5d7d70]' : 'bg-[#f3ece2] text-[#a8764a]'}`}><FileBox size={19} /></div>
                      <div className="min-w-0 flex-1">
                        <div data-testid={`text-scan-asset-${scan.id}`} className="truncate text-sm font-semibold text-[#3d5058]">{scan.vesselAssetName}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#889294]">
                          <span className="font-mono">{scan.moduleType}</span><span className="text-[#c1c7c2]">·</span><span className="truncate">{scan.fileName}</span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] text-[#9aa2a0]">
                          <span>{formatDate(scan.timestamp)}</span><span>·</span><span>{formatSize(scan.fileSize)}</span>
                        </div>
                      </div>
                      <div title={`Uploaded ${formatDate(scan.uploadedAt)}`} className="hidden shrink-0 items-center gap-1 text-[10px] text-[#6e897a] md:flex"><CheckCircle2 size={14} /> Stored</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-[#e4e5df] bg-[#f7f6f0] px-6 py-3 text-[10px] text-[#899392]">
              <span className="flex items-center gap-1.5"><Cloud size={13} /> Saved scan records for this technician</span>
              <span className="font-mono">LATEST FIRST</span>
            </div>
          </section>
        </div>
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-[#d9ddd9] pt-4 text-[10px] text-[#899392]">
          <span>ASC Spatial <span className="mx-1.5 text-[#c1c8c3]">/</span> Field scan intake</span>
          <span className="flex items-center gap-1.5"><Radio size={12} /> Uploads resume only when submitted again</span>
        </footer>
      </div>
    </main>
  );
}

function Home() {
  const { isLoaded, isSignedIn } = useAuth();
  const [, navigate] = useLocation();
  if (!isLoaded) return <LoadingState />;
  if (isSignedIn) return <Redirect to="/workspace" />;
  return <SignIn onLogin={() => navigate('/sign-in')} />;
}

function AccountPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [location] = useLocation();
  const account = useGetAccount({ query: { enabled: isLoaded && !!isSignedIn, retry: false, staleTime: 0, refetchInterval: 30_000, refetchOnWindowFocus: true } });
  const logout = () => void signOut({ redirectUrl: basePath || "/" });
  if (!isLoaded) return <LoadingState />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  if (account.isError) return <main className="min-h-screen bg-[#f5f3ed] p-10"><BrandMark /><h1 className="mt-12 text-2xl">Account access unavailable</h1><p role="alert" className="my-5">{errorMessage(account.error)}</p><button onClick={() => void account.refetch()}>Try again</button><button className="ml-6" onClick={logout}>Log out</button></main>;
  if (!account.data?.user) return <LoadingState />;
  // /api/me resolves the verified session to its authoritative local account ID.
  // Use that ID for uploads; Clerk IDs are only for identity display/comparisons.
  const localUser = { ...account.data.user, profileImageUrl: user?.imageUrl ?? null };
  if (location === '/admin/technicians') {
    if (localUser.isAdmin) return <AdminTechnicians />;
    return <main className="min-h-screen bg-[#f5f3ed] p-10"><BrandMark /><h1 className="mt-12 text-2xl">Administrator access required</h1><p className="my-5 text-sm text-[#6e7a7f]">Your account does not have permission to review technician access.</p><Link href="/workspace" className="underline">Return to workspace</Link></main>;
  }
  if (location === '/profile') return <main className="min-h-screen bg-[#f5f3ed] p-10"><BrandMark /><h1 className="my-8 text-3xl">Your account</h1><section data-testid="account-profile"><p>{user?.primaryEmailAddress?.emailAddress}</p><p>Account ID: {account.data.user.id}</p><p>{localUser.isAdmin ? 'Administrator' : localUser.isTechnician ? 'Approved field technician' : 'Technician approval required'}</p></section><Link href="/workspace" className="mt-8 inline-block underline">Workspace</Link><button data-testid="button-logout" className="ml-6" onClick={logout}>Log out</button></main>;
  return <><nav className="flex gap-5 bg-[#f5f3ed] px-6 py-2 text-sm"><Link href="/profile" className="underline">Your account</Link>{localUser.isAdmin && <Link href="/admin/technicians" className="underline">Technician review</Link>}</nav><div data-testid="account-workspace" data-account-id={account.data.user.id}>{!localUser.isTechnician && !localUser.isAdmin ? <AccessPending onLogout={logout} /> : <ScanWorkspace user={localUser} onLogout={logout} />}</div></>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) queryClient.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);
  return null;
}
function SignInPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-[#f5f3ed] px-4"><ClerkSignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}
function SignUpPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-[#f5f3ed] px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}
function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const [location] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      signInFallbackRedirectUrl={`${basePath}/workspace`}
      signUpFallbackRedirectUrl={`${basePath}/workspace`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to ASC Spatial" } },
        signUp: { start: { title: "Create your account", subtitle: "Verify your email to get started" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
    <QueryClientProvider client={queryClient}>
    <ClerkQueryClientCacheInvalidator />
    <TooltipProvider>
    <ErrorBoundary resetKey={location}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/workspace" component={AccountPage} />
        <Route path="/admin/technicians" component={AccountPage} />
        <Route path="/profile" component={AccountPage} />
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
    <Toaster />
    </TooltipProvider>
    </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
