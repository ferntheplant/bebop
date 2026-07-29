// The CLI's connection to the API.
//
// SPEC section 17.1: "the CLI is a thin wrapper over the generated client with zero CLI-only
// logic". The client here is generated from `BebopHttpApi` — the same declaration the server
// serves and the OpenAPI document is produced from — so a request the CLI can make is by
// construction a request any client can make.

import { BebopHttpApi } from "@bebop/contracts";
import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export const apiUrlVariable = "BEBOP_API_URL";
export const apiTokenVariable = "BEBOP_TOKEN";

export class CliConfigurationError extends Error {
  readonly _tag = "CliConfigurationError";

  constructor(message: string) {
    super(message);
    this.name = "CliConfigurationError";
  }
}

export interface CliConnection {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted<string> | null;
}

/**
 * Resolves where to send requests and what to send with them.
 *
 * Flags win over the environment so a user can talk to a second Bebop without editing their
 * shell profile. The token is `Redacted` from the moment it is read, so an accidental
 * interpolation into an error message cannot print it.
 */
export function resolveConnection(options: {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
}): Effect.Effect<CliConnection, CliConfigurationError> {
  return Effect.gen(function* () {
    const baseUrl = options.url ?? process.env[apiUrlVariable];
    if (baseUrl === undefined || baseUrl.length === 0) {
      return yield* Effect.fail(new CliConfigurationError(`No Bebop API URL. Pass --url or set ${apiUrlVariable}.`));
    }
    if (!URL.canParse(baseUrl)) {
      return yield* Effect.fail(new CliConfigurationError(`"${baseUrl}" is not a URL.`));
    }
    const token = options.token ?? process.env[apiTokenVariable];
    return {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      token: token === undefined || token.length === 0 ? null : Redacted.make(token),
    };
  });
}

/** The generated client, with the bearer credential attached to every request. */
export const bebopClient = Effect.fnUntraced(function* (connection: CliConnection) {
  return yield* HttpApiClient.make(BebopHttpApi, {
    baseUrl: connection.baseUrl,
    transformClient: (client) =>
      connection.token === null
        ? client
        : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(connection.token)),
  });
});

export const CliHttpClientLayer = FetchHttpClient.layer;
