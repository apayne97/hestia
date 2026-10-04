// Generic browser-only Google Drive client, shared in spirit by Hestia (and,
// eventually, lyre and the todo app): one small app-owned file in the
// visitor's own Drive, no backend. Uses the narrow `drive.file` OAuth scope,
// so the app can only see files it created itself or that the user picked
// through the Picker — never the rest of their Drive.
//
//   const drive = createDrive({
//     clientId, apiKey, appId,      // from Google Cloud Console (public by design;
//                                   // restrict the API key to your domains)
//     fileName: "my-data.json",     // default file this app looks for / creates
//     folderName: "My App",         // optional: folder the file lives in, so it
//                                   // doesn't clutter the top level of Drive
//     mimeType: "application/json", // optional
//   });
//   await drive.connect();          // sign-in popup — call from a click
//   const file = await drive.find() || await drive.create("{}");
//
// `appId` is the numeric prefix of the client ID (the Cloud project number);
// the Picker needs it so a picked file is actually granted to this app.
//
// Auth state is per-instance. A 401 clears the token and throws
// DriveAuthError so the UI can ask the user to reconnect.
class DriveAuthError extends Error {}

function createDrive({ clientId, apiKey, appId, fileName, folderName, mimeType = "application/json", scope = "https://www.googleapis.com/auth/drive.file" }) {
  let token = null;

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded) resolve();
        else existing.addEventListener("load", () => resolve());
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => { script.dataset.loaded = "1"; resolve(); };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureGisLoaded() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return;
    await loadScriptOnce("https://accounts.google.com/gsi/client");
  }

  async function ensurePickerLoaded() {
    if (window.google && window.google.picker) return;
    await loadScriptOnce("https://apis.google.com/js/api.js");
    await new Promise((resolve, reject) => {
      gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Failed to load Google Picker")) });
    });
  }

  // Opens the Google sign-in/consent popup (must be called from a click).
  async function connect() {
    await ensureGisLoaded();
    return new Promise((resolve, reject) => {
      google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope,
        callback: (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          token = resp.access_token;
          resolve(token);
        },
        error_callback: (err) => reject(new Error(err.type || "Google sign-in was closed.")),
      }).requestAccessToken();
    });
  }

  function disconnect() {
    const old = token;
    token = null;
    if (old && typeof window !== "undefined" && window.google && window.google.accounts) google.accounts.oauth2.revoke(old, () => {});
  }

  async function api(url, options = {}) {
    if (!token) throw new DriveAuthError("Not connected to Google Drive.");
    const res = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = null;
      throw new DriveAuthError("Your Google sign-in expired.");
    }
    if (!res.ok) throw Object.assign(new Error(`Google Drive request failed (${res.status}).`), { status: res.status });
    return res;
  }

  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const quote = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  async function firstMatch(q) {
    const url = "https://www.googleapis.com/drive/v3/files?" +
      new URLSearchParams({ q, orderBy: "modifiedTime desc", pageSize: "1", fields: "files(id,name)" });
    const { files } = await (await api(url)).json();
    return files && files.length ? files[0] : null;
  }

  // Most recently modified non-trashed file with this name among files the app
  // can see (created by it, or picked earlier) → {id, name} or null. With
  // parentId, only looks inside that folder.
  async function find(name = fileName, parentId) {
    let q = `name='${quote(name)}' and trashed=false`;
    if (parentId) q += ` and '${quote(parentId)}' in parents`;
    return firstMatch(q);
  }

  // Same, for a folder → {id, name} or null.
  async function findFolder(name = folderName) {
    return firstMatch(`name='${quote(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  }

  async function createFolder(name = folderName, parentId) {
    const metadata = { name, mimeType: FOLDER_MIME };
    if (parentId) metadata.parents = [parentId];
    const res = await api("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    return res.json();
  }

  // Move a file into a folder (out of whatever folder(s) it's in now).
  async function move(fileId, folderId) {
    const { parents = [] } = await (await api(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`)).json();
    if (parents.length === 1 && parents[0] === folderId) return;
    const params = new URLSearchParams({ addParents: folderId, fields: "id" });
    if (parents.length) params.set("removeParents", parents.join(","));
    await api(`https://www.googleapis.com/drive/v3/files/${fileId}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  }

  // Files the app creates itself need no Picker grant under drive.file.
  async function create(content, name = fileName, parentId) {
    const boundary = "gdrive-boundary-" + Math.random().toString(36).slice(2);
    const metadata = { name, mimeType };
    if (parentId) metadata.parents = [parentId];
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const res = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  }

  async function read(fileId) {
    return (await api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).text();
  }

  async function write(fileId, content) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body: content,
    });
  }

  function runPicker(view) {
    return new Promise((resolve, reject) => {
      if (!token) { reject(new DriveAuthError("Not connected to Google Drive.")); return; }
      new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) resolve({ id: data.docs[0].id, name: data.docs[0].name });
          else if (data.action === google.picker.Action.CANCEL) resolve(null);
        })
        .build()
        .setVisible(true);
    });
  }

  // Fallback for when find() comes up empty on a new device: let the user pick
  // the file (picking is what grants the app access under drive.file).
  // parentId, if given, scopes the picker to that folder.
  // → {id, name}, or null if cancelled.
  async function pick(parentId) {
    await ensurePickerLoaded();
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(false).setSelectFolderEnabled(false);
    if (parentId) view.setParent(parentId);
    return runPicker(view);
  }

  // Same, for choosing a folder.
  async function pickFolder() {
    await ensurePickerLoaded();
    return runPicker(new google.picker.DocsView(google.picker.ViewId.FOLDERS).setSelectFolderEnabled(true));
  }

  return {
    connect, disconnect, find, findFolder, createFolder, move, create, read, write, pick, pickFolder,
    isConnected: () => !!token,
    _setToken: (t) => { token = t; }, // test hook
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createDrive, DriveAuthError };
