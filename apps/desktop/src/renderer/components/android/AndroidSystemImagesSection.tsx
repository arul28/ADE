import { useState, type ReactNode } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidSystemImageEntry, AndroidSystemImageInventory } from "../../../shared/types/androidEmulator";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { confirmDialog } from "../ui/dialog/confirm";
import { Banner } from "../ui/notice";
import { Spinner } from "../ui/Spinner";
import { ANDROID_TILE_FOCUS_RING } from "./AndroidCatalogGrid";
import { AndroidLicenseDialog } from "./AndroidLicenseDialog";
import { formatAndroidBytes } from "../../../shared/androidFormat";
import { androidInstallLine } from "./androidSdkFormat";
import { useAndroidSystemImages } from "./useAndroidSystemImages";

/**
 * System images ▸, under Storage in the device picker (the Apple picker's
 * Runtimes section). The images installed on the lane's machine, each with its
 * size and the AVDs that boot from it, then the phone images Google publishes
 * for that machine's ABI.
 *
 * Install shows each licence in full (the setup card's dialog) and runs on the
 * machine's one SDK install job, with progress and Cancel. Remove asks first;
 * when AVDs use the image, the question names them. ADE never deletes an
 * AVD's files here. Every call goes to the lane's machine (`pin`).
 */
export function AndroidSystemImagesSection({
  pin,
  machineName,
}: {
  /** The lane's machine; null is the tab's own machine. */
  pin: OpenProjectBinding | null;
  machineName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [consentFor, setConsentFor] = useState<AndroidSystemImageEntry | null>(null);
  const images = useAndroidSystemImages(pin, open);
  const inventory = images.inventory;
  const installed = (inventory?.images ?? []).filter((image) => image.installed);
  const offered = (inventory?.images ?? []).filter((image) => image.available && (!image.installed || image.updateAvailable));
  const running = images.install.state === "running";
  const busy = running || images.sending !== null;
  const installedBytes = installed.reduce((sum, image) => sum + (image.sizeBytes ?? 0), 0);

  const askInstall = (entry: AndroidSystemImageEntry) => {
    images.clearActionError();
    if (!entry.available?.licenseId) {
      void images.startInstall(entry, []);
      return;
    }
    setConsentFor(entry);
  };

  const askRemove = async (entry: AndroidSystemImageEntry) => {
    images.clearActionError();
    const names = entry.avds.map((avd) => avd.displayName ?? avd.name);
    const size = entry.sizeBytes ? formatAndroidBytes(entry.sizeBytes) : null;
    const confirmed = await confirmDialog({
      title: `Remove ${entry.name}?`,
      message: names.length
        ? `${names.length === 1 ? "This device uses" : `These ${names.length} devices use`} it: ${names.join(", ")}. `
          + "ADE keeps their files, but they cannot start until you install this image again."
        : `No device uses it.${size ? ` This frees ${size}.` : ""}`,
      confirmLabel: size ? `Remove · ${size}` : "Remove",
      destructive: true,
    });
    if (confirmed) await images.remove(entry, names.length > 0);
  };

  const licenseFor = (entry: AndroidSystemImageEntry, all: AndroidSystemImageInventory) =>
    all.licenses.filter((license) => license.id === entry.available?.licenseId);

  return (
    <section aria-label="System images" data-android-picker-section="System images" className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        data-android-images-toggle=""
        onClick={() => setOpen(!open)}
        className={cn(
          "flex min-w-0 items-center gap-1 self-start rounded-[6px] px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg hover:text-fg",
          ANDROID_TILE_FOCUS_RING,
        )}
      >
        <span>System images</span>
        <CaretRight size={10} weight="bold" aria-hidden="true" className={cn("transition-transform duration-[160ms]", open && "rotate-90")} />
        {open && inventory ? (
          <span className="pl-1 font-normal normal-case tracking-normal text-fg/60">
            {`${installed.length} installed${installedBytes > 0 ? ` · ${formatAndroidBytes(installedBytes)}` : ""}`}
          </span>
        ) : null}
      </button>
      {open ? (
        <div data-android-images="" className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-1.5 p-3">
          {images.loading && !inventory ? (
            <p className="flex items-center gap-2 font-sans text-[11px] leading-4 text-muted-fg"><Spinner />Reading the images…</p>
          ) : images.error && !inventory ? (
            <Banner
              layout="inline"
              model={{
                id: "android-images-read-error",
                tone: "warning",
                title: "Could not read the system images",
                detail: images.error.sentence,
                error: images.error.detail ?? undefined,
                actions: [{ label: "Retry", onClick: images.refresh }],
              }}
            />
          ) : inventory ? (
            <>
              {!inventory.sdkRoot ? (
                <p className="font-sans text-[11px] leading-4 text-muted-fg">Set up the Android SDK first. Then you can add images here.</p>
              ) : null}
              {installed.length ? (
                <ul className="flex min-w-0 flex-col gap-1">
                  {installed.map((entry) => (
                    <ImageRow
                      key={entry.id}
                      entry={entry}
                      detail={[
                        entry.sizeBytes ? formatAndroidBytes(entry.sizeBytes) : null,
                        entry.avds.length
                          ? `${entry.avds.length} device${entry.avds.length === 1 ? "" : "s"}: ${entry.avds.map((avd) => avd.displayName ?? avd.name).join(", ")}`
                          : "no devices",
                      ].filter(Boolean).join(" · ")}
                      action={(
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || entry.avds.some((avd) => avd.running)}
                          aria-label={`Remove ${entry.name}`}
                          data-android-image-remove={entry.id}
                          onClick={() => void askRemove(entry)}
                          className="h-6 shrink-0 px-2 text-[11px] text-muted-fg"
                        >
                          {images.sending === entry.id && !running ? <Spinner /> : "Remove"}
                        </Button>
                      )}
                    />
                  ))}
                </ul>
              ) : inventory.sdkRoot ? (
                <p className="font-sans text-[11px] leading-4 text-muted-fg">No system images are installed.</p>
              ) : null}

              {running ? (
                <InstallProgress
                  install={images.install}
                  label={images.installingId ? null : "Another Android SDK install runs on this machine."}
                  onCancel={images.cancelInstall}
                />
              ) : null}

              {offered.length ? (
                <>
                  <h4 className="pt-1.5 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg">Available</h4>
                  <ul className="flex min-w-0 flex-col gap-1">
                    {offered.map((entry) => (
                      <ImageRow
                        key={entry.id}
                        entry={entry}
                        detail={[
                          entry.available ? `${formatAndroidBytes(entry.available.downloadBytes)} download` : null,
                          entry.updateAvailable ? `update to revision ${entry.available?.revision ?? "?"}` : null,
                          entry.emulatorTooOld ? `needs emulator ${entry.available?.needsEmulator ?? "newer"}` : null,
                        ].filter(Boolean).join(" · ")}
                        action={(
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy || entry.emulatorTooOld || !inventory.sdkRoot}
                            aria-label={`${entry.updateAvailable ? "Update" : "Install"} ${entry.name}`}
                            data-android-image-install={entry.id}
                            onClick={() => askInstall(entry)}
                            className="h-6 shrink-0 px-2 text-[11px] text-accent"
                          >
                            {images.sending === entry.id ? <Spinner /> : entry.updateAvailable ? "Update" : "Install"}
                          </Button>
                        )}
                      />
                    ))}
                  </ul>
                </>
              ) : null}

              {inventory.repositoryError ? (
                <Banner
                  layout="inline"
                  model={{
                    id: "android-images-repository",
                    tone: "warning",
                    title: "Google's SDK repository is not reachable",
                    detail: "The installed images are listed. Check this machine's internet connection to see the ones to add.",
                    error: inventory.repositoryError,
                    actions: [{ label: "Retry", onClick: images.refresh }],
                  }}
                />
              ) : null}
              {images.actionError ? (
                <Banner
                  layout="inline"
                  model={{
                    id: "android-images-action-error",
                    tone: "warning",
                    title: images.actionError.sentence,
                    error: images.actionError.detail ?? undefined,
                    report: false,
                    dismiss: { onDismiss: images.clearActionError },
                  }}
                />
              ) : null}
              <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
                A system image is the Android a device runs. New phones use the newest one installed.
                {inventory.diskBytesFree !== null ? ` ${formatAndroidBytes(inventory.diskBytesFree)} free.` : ""}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {consentFor && inventory ? (
        <AndroidLicenseDialog
          licenses={licenseFor(consentFor, inventory)}
          parts={[{ id: "system-image", label: consentFor.name }]}
          downloadBytes={consentFor.available?.downloadBytes ?? 0}
          sdkRoot={inventory.sdkRoot ?? ""}
          machineName={machineName}
          starting={images.sending === consentFor.id}
          onCancel={() => setConsentFor(null)}
          onAccept={(acceptedLicenseIds) => {
            const entry = consentFor;
            void images.startInstall(entry, acceptedLicenseIds).then(() => setConsentFor(null));
          }}
        />
      ) : null}
    </section>
  );
}

function ImageRow({ entry, detail, action }: { entry: AndroidSystemImageEntry; detail: string; action: ReactNode }) {
  return (
    <li data-android-image={entry.id} className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-sans text-[12px] font-medium leading-5 text-fg">{entry.name}</span>
          {entry.newest ? (
            <span className="shrink-0 font-sans text-[10px] uppercase tracking-[0.08em] text-muted-fg">newest</span>
          ) : null}
        </span>
        <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">{detail}</span>
      </div>
      {action}
    </li>
  );
}

function InstallProgress({
  install,
  label,
  onCancel,
}: {
  install: ReturnType<typeof useAndroidSystemImages>["install"];
  /** Set when the running job is not an image install (the setup card's). */
  label: string | null;
  onCancel: () => void;
}) {
  if (install.state !== "running") return null;
  const line = androidInstallLine(install);
  return (
    <div data-android-image-progress="" className="flex min-w-0 flex-col gap-1 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.max(2, Math.round(line.fraction * 100))}%` }}
          />
        </div>
        {label ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={install.cancelling}
            onClick={onCancel}
            className="h-6 shrink-0 px-2 text-[11px] text-muted-fg"
          >
            Cancel
          </Button>
        )}
      </div>
      <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">{label ?? line.text}</span>
    </div>
  );
}
