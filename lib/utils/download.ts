/** Triggers a browser download for a Blob, cleaning up the object URL after. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
