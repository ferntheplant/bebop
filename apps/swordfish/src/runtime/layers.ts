import type { Config } from "effect";
import { Layer } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

import type { SwordfishConfiguration } from "#src/config.ts";
import { SwordfishConfigurationLayer } from "#src/config.ts";
import type { ShutdownSignal } from "#src/daemon/shutdown.ts";
import { ShutdownSignalLayer } from "#src/daemon/shutdown.ts";
import type { SwordfishIdentity } from "#src/domain/identity.ts";
import { SwordfishIdentityLayer } from "#src/domain/identity.ts";
import { DatabaseLayer, type DatabaseDirectoryError } from "#src/persistence/database.ts";
import type { SwordfishStore } from "#src/persistence/store.ts";
import { SwordfishStoreLayer } from "#src/persistence/store.ts";
import type { WorkflowService } from "#src/workflow/service.ts";
import { WorkflowServiceLayer } from "#src/workflow/service.ts";

type RuntimeLayer = Layer.Layer<
  SwordfishConfiguration | SwordfishIdentity | SwordfishStore | WorkflowService | SqlClient.SqlClient | ShutdownSignal,
  Config.ConfigError | DatabaseDirectoryError | SqlError.SqlError
>;

export function swordfishRuntimeLayer(options?: {
  readonly configuration?: Layer.Layer<SwordfishConfiguration>;
  readonly identity?: Layer.Layer<SwordfishIdentity>;
}): RuntimeLayer {
  const StoreRuntimeLayer = SwordfishStoreLayer.pipe(
    Layer.provideMerge(DatabaseLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        options?.configuration ?? SwordfishConfigurationLayer,
        options?.identity ?? SwordfishIdentityLayer,
      ),
    ),
  );
  return WorkflowServiceLayer.pipe(Layer.provideMerge(StoreRuntimeLayer), Layer.provideMerge(ShutdownSignalLayer));
}

export const SwordfishRuntimeLayer = swordfishRuntimeLayer();
