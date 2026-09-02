import type {
  IToolProcessorRegistry,
  ToolProcessor,
} from "@/src/application/ports/processing/ToolProcessor";
import { ProcessorNotFoundError } from "@/src/application/ports/processing/ToolProcessor";

/**
 * A registry of processors, keyed by tool slug.
 *
 * Registration is explicit and rejects duplicates: two processors claiming the
 * same slug is a wiring bug that would otherwise resolve to whichever was
 * registered last, silently.
 */
export class ToolProcessorRegistry implements IToolProcessorRegistry {
  private readonly processors = new Map<string, ToolProcessor>();

  constructor(processors: ToolProcessor[] = []) {
    for (const p of processors) this.register(p);
  }

  register(processor: ToolProcessor): void {
    if (this.processors.has(processor.id)) {
      throw new Error(`Duplicate processor registration for "${processor.id}".`);
    }
    this.processors.set(processor.id, processor);
  }

  get(slug: string): ToolProcessor | undefined {
    return this.processors.get(slug);
  }

  require(slug: string): ToolProcessor {
    const found = this.processors.get(slug);
    if (!found) throw new ProcessorNotFoundError(slug);
    return found;
  }

  has(slug: string): boolean {
    return this.processors.has(slug);
  }

  ids(): string[] {
    return [...this.processors.keys()].sort();
  }
}
