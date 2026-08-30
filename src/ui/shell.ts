/**
 * Clone the inert document shell shipped in index.html. Keeping invariant markup
 * in HTML avoids parsing and compiling a large JavaScript template literal while
 * preserving a fresh DOM for every studio instance.
 */
export function renderAppShell(appElement: HTMLElement): void {
  const template = document.getElementById("app-shell-template");
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error("Application shell template was not found");
  }
  appElement.replaceChildren(template.content.cloneNode(true));
}
