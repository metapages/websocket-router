/** Minimal cookie-jar client for the admin API. */
export class AdminClient {
  #cookie: string | null = null;

  constructor(private readonly origin: string) {}

  async request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    if (this.#cookie) headers.set("Cookie", this.#cookie);

    const response = await fetch(`${this.origin}/admin${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const first = setCookie.split(";")[0];
      if (first) this.#cookie = first;
    }

    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  }

  login(password: string) {
    return this.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  get hasSession(): boolean {
    return this.#cookie !== null;
  }
}
