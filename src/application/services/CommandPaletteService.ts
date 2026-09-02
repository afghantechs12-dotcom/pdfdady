import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import {
  COMMAND_LIMITS,
  evaluateCommand,
  isValidCommand,
  searchCommands,
  type CommandContext,
  type CommandDescriptor,
  type EvaluatedCommand,
} from "@/src/domain/entities/CommandPalette";
import { DomainError, NotFoundError } from "@/src/domain/errors";

/** What the caller asks to run, and where. */
export interface CommandExecutionRequest {
  commandId: string;
  workspaceId: string;
  /** The document the command targets, when it targets one. */
  documentId?: string | null;
  /** The pane the command applies to. */
  paneId?: string;
}

export interface CommandExecutionResult {
  commandId: string;
  workspaceId: string;
  documentId: string | null;
  paneId: string;
  /** The actor's Workspace role at execution time. */
  role: string;
}

/**
 * M7.14 command palette.
 *
 * The registry is a catalogue, not a capability. Two rules follow from that and
 * both are enforced here rather than left to the UI:
 *
 * **Execution re-authorizes, always.** `execute` calls `WorkspaceService.get`
 * with the write flag the command declares, and resolves the target document
 * within the Workspace, *regardless of what the palette displayed*. A descriptor
 * arrives from the client as an id; if enablement were trusted, knowing an id
 * would be enough to invoke anything. The `enabled` flag decides what is offered
 * and nothing more.
 *
 * **Search is local and deterministic.** No model call, no network round-trip
 * per keystroke, and the same query always returns the same order — a palette
 * that sometimes ranks differently for the same keystrokes is one users stop
 * trusting.
 */
export class CommandPaletteService {
  private readonly commands = new Map<string, CommandDescriptor>();

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
  ) {}

  // ---- registry ------------------------------------------------------------

  /** Registers a command, replacing any existing one with the same id. */
  register(command: CommandDescriptor): void {
    if (!isValidCommand(command)) {
      throw new DomainError("That command descriptor is not valid.");
    }
    this.commands.set(command.id, command);
  }

  registerAll(commands: readonly CommandDescriptor[]): void {
    for (const command of commands) this.register(command);
  }

  unregister(commandId: string): boolean {
    return this.commands.delete(commandId);
  }

  get(commandId: string): CommandDescriptor | null {
    return this.commands.get(commandId) ?? null;
  }

  /** Every registered command, in registration order. */
  list(): CommandDescriptor[] {
    return [...this.commands.values()];
  }

  // ---- search --------------------------------------------------------------

  /**
   * Searches the registry against a context.
   *
   * Disabled commands come back with a reason rather than being filtered out;
   * hiding a command a user knows exists reads as the feature having been
   * removed.
   */
  search(query: string, context: CommandContext): EvaluatedCommand[] {
    return searchCommands(this.list(), query, context);
  }

  /** One command evaluated against a context, or null when unregistered. */
  evaluate(commandId: string, context: CommandContext): EvaluatedCommand | null {
    const command = this.commands.get(commandId);
    return command ? evaluateCommand(command, context) : null;
  }

  // ---- execution -----------------------------------------------------------

  /**
   * Authorizes and resolves a command execution.
   *
   * Returns the resolved target rather than performing the work: the palette's
   * job is to decide *whether* and *against what*, and the feature services own
   * the doing. Keeping the two apart is what stops the palette from becoming a
   * second, weaker path into every feature.
   */
  async execute(
    actor: ActorContext,
    request: CommandExecutionRequest,
  ): Promise<CommandExecutionResult> {
    if (
      typeof request.commandId !== "string" ||
      request.commandId.trim() === "" ||
      request.commandId.length > COMMAND_LIMITS.maxIdLength
    ) {
      throw new DomainError("A valid command id is required.");
    }

    const command = this.commands.get(request.commandId);
    // An unregistered id is not found rather than forbidden: the palette should
    // not confirm which commands exist to someone guessing.
    if (!command) throw new NotFoundError("Command not found.");

    const requiresWrite = command.requirements?.write === true;
    // The re-authorization. Whatever the client believed about enablement, this
    // is the check that decides.
    const { workspace, role } = await this.workspaces.get(
      actor,
      request.workspaceId,
      requiresWrite,
    );

    let documentId: string | null = null;
    if (command.requirements?.document === true) {
      if (typeof request.documentId !== "string" || request.documentId.trim() === "") {
        throw new DomainError("This command needs a document.");
      }
      const document = await this.documents.getById(workspace.id, request.documentId);
      // Resolved within the Workspace, so a document id from another tenant
      // reads as missing rather than as forbidden.
      if (!document) throw new NotFoundError("Document not found in this workspace.");
      documentId = document.id;
    }

    const paneId = request.paneId ?? "left";

    this.logger.info("Command executed", {
      commandId: command.id,
      workspaceId: workspace.id,
      documentId,
      paneId,
    });

    return { commandId: command.id, workspaceId: workspace.id, documentId, paneId, role };
  }
}
