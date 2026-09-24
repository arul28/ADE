// Run with `npm run test:lint-tooling` (node --test). Lives outside src/, so the
// desktop vitest suite does not collect it; CI runs it in the lint-desktop job.
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import plugin from "./ade-ui.mjs";

const require = createRequire(import.meta.url);

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  parser: require.resolve("@typescript-eslint/parser"),
  parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
});

const FILE = "/repo/apps/desktop/src/renderer/components/lanes/Thing.tsx";
const rule = (name) => plugin.rules[name];

tester.run("no-native-dialogs", rule("no-native-dialogs"), {
  valid: [
    "const ok = await confirmDialog({ title: 'Delete?' });",
    // A local function named confirm is not the native dialog.
    "function confirm(x) { return x; } confirm(1);",
    "const prompt = (s) => s; prompt('x');",
    "props.confirm();",
    "api.alert('x');",
  ],
  invalid: [
    { code: "window.confirm('Delete?');", errors: [{ messageId: "confirm" }] },
    { code: "if (!confirm('Delete?')) return;", errors: [{ messageId: "confirm" }] },
    { code: "const name = window.prompt('Name');", errors: [{ messageId: "prompt" }] },
    { code: "prompt('Name');", errors: [{ messageId: "prompt" }] },
    { code: "alert('Done');", errors: [{ messageId: "alert" }] },
    { code: "globalThis.alert('Done');", errors: [{ messageId: "alert" }] },
    { code: "window['confirm']('x');", errors: [{ messageId: "confirm" }] },
    { code: "window.confirm?.('x');", errors: [{ messageId: "confirm" }] },
  ],
});

tester.run("no-adhoc-notice-component", rule("no-adhoc-notice-component"), {
  valid: [
    {
      code: "import { Banner } from '../ui/notice';\nexport function RebaseBanner() { return <Banner model={m} />; }",
      filename: FILE,
    },
    {
      code: "import { showToast } from '../app/toast/toastStore';\nexport const SavedToast = () => null;",
      filename: FILE,
    },
    {
      code: "import { Banner } from '../../ui/notice/Banner';\nexport const X = memo(function OutageNotice() { return null; });",
      filename: FILE,
    },
    // Not components: lowercase, plural hook names, non-function values.
    "export function useLaneEventToasts() {}",
    "const bannerNotice = () => null;",
    "const ERROR_BANNER = 'x';",
    "export function BannerList() { return null; }",
  ],
  invalid: [
    {
      code: "export function PrRebaseBanner() { return <div className='rounded border' />; }",
      errors: [{ messageId: "adhoc", data: { name: "PrRebaseBanner" } }],
    },
    {
      code: "const SavedToast = () => <div />;\nconst QuotaCallout = memo(() => null);",
      errors: [{ messageId: "adhoc" }, { messageId: "adhoc" }],
    },
    {
      code: "import { X } from '../ui/Button';\nexport const UpdateSnackbar = forwardRef(() => null);\nclass LegacyNotice {}",
      errors: [{ messageId: "adhoc" }, { messageId: "adhoc" }],
    },
  ],
});

tester.run("no-fixed-overlay", rule("no-fixed-overlay"), {
  valid: [
    "const s = { position: 'absolute' };",
    "<div className='fixed-width flex' />;",
    "<div className='prefixed' />;",
    "const label = 'fixed';", // not a class list
    "doThing('fixed');",
    "<div title='fixed' />;",
    "<div className={open ? 'block' : 'hidden'} />;",
    "<div className={cond === 'fixed' ? 'a' : 'b'} />;",
  ],
  invalid: [
    { code: "const s = { position: 'fixed', inset: 0 };", errors: [{ messageId: "style" }] },
    { code: "<div style={{ position: \"fixed\" }} />;", errors: [{ messageId: "style" }] },
    { code: "const s = { position: open ? 'fixed' : 'relative' };", errors: [{ messageId: "style" }] },
    { code: "const s = { 'position': 'fixed' };", errors: [{ messageId: "style" }] },
    { code: "<div className='fixed inset-0' />;", errors: [{ messageId: "className" }] },
    { code: "<div className=\"md:fixed top-0\" />;", errors: [{ messageId: "className" }] },
    { code: "<div className={`fixed ${pos} z-10`} />;", errors: [{ messageId: "className" }] },
    { code: "<div className={cn('inset-0', open && 'fixed')} />;", errors: [{ messageId: "className" }] },
    { code: "const cls = clsx('fixed', 'inset-0');", errors: [{ messageId: "className" }] },
    { code: "<div className={open ? 'fixed inset-0' : 'hidden'} />;", errors: [{ messageId: "className" }] },
    { code: "<div className={'a ' + 'fixed'} />;", errors: [{ messageId: "className" }] },
  ],
});

tester.run("no-raw-z-index", rule("no-raw-z-index"), {
  valid: [
    "const s = { zIndex: 10 };",
    "const s = { zIndex: 49 };",
    "const s = { zIndex: Z_LAYERS.dialog };",
    "const s = { zIndex: -1 };",
    "<div className='z-10 z-40 z-[49]' />;",
    "const x = { depth: 200 };",
    "const label = 'z-50';", // not a class list
  ],
  invalid: [
    {
      code: "const s = { zIndex: 50 };",
      errors: [{ messageId: "style", data: { value: "50" } }],
    },
    { code: "<div style={{ zIndex: 9999 }} />;", errors: [{ messageId: "style" }] },
    { code: "const s = { zIndex: open ? 200 : 1 };", errors: [{ messageId: "style" }] },
    { code: "const s = { zIndex: '100' };", errors: [{ messageId: "style" }] },
    {
      code: "<div className='fixed z-[120]' />;",
      errors: [{ messageId: "className", data: { token: "z-[120]" } }],
    },
    { code: "<div className='relative z-50' />;", errors: [{ messageId: "className", data: { token: "z-50" } }] },
    { code: "<div className={cn('a', 'hover:z-[60]')} />;", errors: [{ messageId: "className" }] },
    { code: "<div className={`z-[200] ${x}`} />;", errors: [{ messageId: "className" }] },
  ],
});

tester.run("no-legacy-banner-import", rule("no-legacy-banner-import"), {
  valid: [
    { code: "import { Banner } from '../ui/notice';", filename: FILE },
    { code: "import { Banner } from './Banner';", filename: FILE },
    { code: "import { toast } from './toastStore';", filename: FILE },
    { code: "import x from 'sonnerish';", filename: FILE },
  ],
  invalid: [
    {
      code: "import { Banner } from '../shared/Banner';",
      filename: FILE,
      errors: [{ messageId: "banner" }],
    },
    {
      code: "import { Banner } from './Banner';",
      filename: "/repo/apps/desktop/src/renderer/components/shared/Other.tsx",
      errors: [{ messageId: "banner" }],
    },
    {
      code: "import { Banner } from '@/renderer/components/shared/Banner';",
      filename: FILE,
      errors: [{ messageId: "banner" }],
    },
    { code: "import { toast } from 'sonner';", errors: [{ messageId: "toast", data: { source: "sonner" } }] },
    { code: "import toast from 'react-hot-toast';", errors: [{ messageId: "toast" }] },
    { code: "import * as Toast from '@radix-ui/react-toast';", errors: [{ messageId: "toast" }] },
    { code: "import 'react-toastify/dist/ReactToastify.css';", errors: [{ messageId: "toast" }] },
    { code: "const t = await import('sonner');", errors: [{ messageId: "toast" }] },
    { code: "export { toast } from 'sonner';", errors: [{ messageId: "toast" }] },
  ],
});
