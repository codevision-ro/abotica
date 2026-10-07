/**
 * Programmatic navigation (router.push from menus) does not go through link clicks, so pages that
 * guard unsaved changes cannot see it. Callers announce it with a cancelable window event first.
 *
 * Listener contract: `window.addEventListener(NAVIGATE_EVENT, (e) => { e.preventDefault(); ...; e.detail.proceed(); })`.
 * Calling `preventDefault()` cancels the navigation; call `detail.proceed()` later to carry it out.
 */
export const NAVIGATE_EVENT = "abotica:navigate";

type NavigateDetail = { href: string; proceed: () => void };

declare global {
  interface WindowEventMap {
    [NAVIGATE_EVENT]: CustomEvent<NavigateDetail>;
  }
}

/** Runs `proceed` now unless a listener cancels the navigation (it may run `proceed` later). */
export function requestNavigation(href: string, proceed: () => void) {
  const allowed = window.dispatchEvent(
    new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, { detail: { href, proceed }, cancelable: true }),
  );
  if (allowed) proceed();
}
