import type { RelayErrorBody } from "@cipherchat/shared";
import { RelayHttpError } from "./errors.js";

export interface HttpClientOptions {
  serverUrl: string;
  // Read per request so a refreshed token is picked up without a new client.
  getToken: () => string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  get serverUrl(): string {
    return this.options.serverUrl;
  }

  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.options.serverUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.getToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (payload ?? {}) as Partial<RelayErrorBody>;
      throw new RelayHttpError(
        response.status,
        error.code ?? "HTTP_ERROR",
        error.message ?? `Request failed with status ${response.status}`,
        error.data
      );
    }

    return payload as T;
  }
}
