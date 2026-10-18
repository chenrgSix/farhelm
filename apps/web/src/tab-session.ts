const key = "farhelm.tab-session.v1";

export interface TabSession {
  token: string;
  view: string;
}

// Only the current tab's credential and page are retained. Identity and
// permissions always come from /me; passwords and terminal input are never saved.
export function readTabSession(): TabSession | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (
      typeof saved?.token !== "string" ||
      !/^[A-Za-z0-9_-]{1,4096}$/.test(saved.token) ||
      typeof saved.view !== "string" ||
      saved.view.length > 32
    ) {
      sessionStorage.removeItem(key);
      return null;
    }
    return { token: saved.token, view: saved.view };
  } catch {
    // Storage can be disabled by browser policy. In-memory login still works.
    writeTabSession(null);
    return null;
  }
}

export function writeTabSession(session: TabSession | null): boolean {
  try {
    if (session) sessionStorage.setItem(key, JSON.stringify(session));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
