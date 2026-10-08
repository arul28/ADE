import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import type { HomeLayoutItem, HomeWidgetType } from "./homeLayout";
import { HOME_WIDGET_CATALOG } from "./homeWidgetCatalog";
import { WelcomeCardHead } from "../projects/ProjectWelcomeSidePanels";

/**
 * The widgets added after the home page shipped. Each is its own chunk,
 * fetched only when it is on someone's layout, so the default page pays
 * nothing for them on first paint.
 */

export type HomeWidgetProps = { item: HomeLayoutItem };

type LazyWidget = LazyExoticComponent<ComponentType<HomeWidgetProps>>;

const LAZY_WIDGETS: Partial<Record<HomeWidgetType, LazyWidget>> = {
  clock: lazy(() => import("./widgets/ClockWeatherWidget")),
  pomodoro: lazy(() => import("./widgets/PomodoroWidget")),
  clipboard: lazy(() => import("./widgets/ClipboardWidget")),
  machine: lazy(() => import("./widgets/MachineHealthWidget")),
  heatmap: lazy(() => import("./widgets/ContributionsWidget")),
  shipped: lazy(() => import("./widgets/ShippedWidget")),
};

function WidgetShell({ type, message }: { type: HomeWidgetType; message?: string }) {
  const meta = HOME_WIDGET_CATALOG[type];
  return (
    <section className="kit-card ade-home-card" aria-label={meta.title} aria-busy={message ? undefined : true}>
      <WelcomeCardHead icon={meta.icon} title={meta.title} />
      <div className="ade-home-empty">{message ? <span>{message}</span> : null}</div>
    </section>
  );
}

export function LazyHomeWidget({ item }: HomeWidgetProps) {
  const Widget = LAZY_WIDGETS[item.type];
  const meta = HOME_WIDGET_CATALOG[item.type];
  if (!Widget) return <WidgetShell type={item.type} message={meta.comingSoon ?? "Not available."} />;
  if (meta.desktopOnly && !window.ade?.home) {
    return <WidgetShell type={item.type} message="Available in the ADE desktop app." />;
  }
  return (
    <Suspense fallback={<WidgetShell type={item.type} />}>
      <Widget item={item} />
    </Suspense>
  );
}
