// Shrinks photos in the browser before upload. A phone photo is 2-5 MB at 12-48 MP; the server
// keeps at most 1568 px anyway, so sending that size cuts the upload about 10x and the server's
// decode work about 6x (see bench/RESULTS.md). Anything the browser cannot decode is sent as is
// and the server decides.
const MAX_SIDE = 1568;

async function shrink(file) {
  if (!/^image\/(jpeg|png)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) { bmp.close(); return file; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // PNG transparency becomes white, as on the server
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

// Returns a copy of `form` with every file under `field` shrunk, four at a time.
export async function shrinkPhotos(form, field = "photos") {
  const files = form.getAll(field).filter((f) => f instanceof File && f.size > 0);
  const out = new Array(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < files.length) { const i = next++; out[i] = await shrink(files[i]); } }));
  const copy = new FormData();
  for (const [k, v] of form.entries()) if (k !== field) copy.append(k, v);
  for (const f of out) copy.append(field, f, f.name);
  return copy;
}
