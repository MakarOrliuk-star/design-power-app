/**
 * Trigger a browser download via a temporary same-origin anchor. A GET
 * navigation (not fetch) so the session cookie rides along through the proxy
 * and the response streams straight into the browser's download manager —
 * shared by the Archive/Result ZIP exports and the Tournament DES export.
 */
export function downloadUrl(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
