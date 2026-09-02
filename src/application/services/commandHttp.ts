import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { CommandPaletteService } from "./CommandPaletteService";
import type { OperationCenterService } from "./OperationCenterService";
import type { EvaluatedCommand, OperationDescriptor } from "@/src/domain/entities/CommandPalette";
import {
  COMMAND_LIMITS,
  canCancelOperation,
  canOpenOperationResult,
  canRetryOperation,
} from "@/src/domain/entities/CommandPalette";

export function commandPaletteService(): CommandPaletteService {
  return appContainer.resolve<CommandPaletteService>(Tokens.CommandPaletteService);
}

export function operationCenterService(): OperationCenterService {
  return appContainer.resolve<OperationCenterService>(Tokens.OperationCenterService);
}

/**
 * Serializes a command for the wire.
 *
 * The descriptor is a catalogue entry, so everything here is display material:
 * `enabled` and `disabledReason` tell the client what to grey out and why, and
 * neither is an authorization. Execution re-checks against the Workspace, which
 * is why it is safe to hand a client the full command list.
 */
export function toCommandResponse(command: EvaluatedCommand) {
  return {
    id: command.id,
    label: command.label,
    category: command.category,
    shortcut: command.shortcut ?? null,
    enabled: command.enabled,
    disabledReason: command.disabledReason,
  };
}

/**
 * Serializes an operation.
 *
 * `resultRef` is deliberately not emitted. It is an internal handle to whatever
 * the work produced — a storage key in some cases — and a client only needs to
 * know whether a result exists. Opening one goes through the result route, which
 * re-authorizes.
 */
export function toOperationResponse(operation: OperationDescriptor) {
  return {
    id: operation.id,
    type: operation.type,
    documentId: operation.documentId,
    label: boundedLabel(operation.label),
    status: operation.status,
    // Already reconciled with status by the domain, so a client never renders
    // "completed, 60%".
    progress: operation.progress,
    error: boundedError(operation.error),
    hasResult: canOpenOperationResult(operation),
    canCancel: canCancelOperation(operation),
    canRetry: canRetryOperation(operation),
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

/** Bounds a label on the way out, in case an older build wrote a longer one. */
function boundedLabel(value: string): string {
  const characters = [...value];
  return characters.length <= COMMAND_LIMITS.maxLabelLength
    ? value
    : characters.slice(0, COMMAND_LIMITS.maxLabelLength).join("");
}

function boundedError(value: string | null): string | null {
  if (value === null) return null;
  const characters = [...value];
  return characters.length <= COMMAND_LIMITS.maxErrorLength
    ? value
    : characters.slice(0, COMMAND_LIMITS.maxErrorLength).join("");
}
