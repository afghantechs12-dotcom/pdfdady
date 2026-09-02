import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PDF_MIME,
  awaitingDestinationChoice,
  resolveInitialSelection,
  resultWorkflowActions,
  savedDocumentHref,
  shouldStartSave,
  signInHref,
  type ResultSaveState,
  type ResultSaveTarget,
  type SaveDestination,
} from "./resultWorkflow";
import { TOOL_CAPABILITIES, capabilityForSlug } from "@/lib/tools/capability";

/**
 * T2-T7 and T19-T21 — a result's onward journey, and the four ways it must not
 * travel.
 *
 * The recording's merge result offered Download and Start over, so the only route
 * back into the product was the user's Downloads folder. The two CTAs that fix it
 * have to appear on two unrelated surfaces (`ResultActions` for the browser tools,
 * `JobStatePanel` for the server jobs) and must never disagree, so what is checked
 * here is one decision function against the REAL capability matrix, plus the four
 * transports underneath it — because the actions are identical and the transports
 * deliberately are not.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const shared = stripComments(read("components", "tools", "ResultWorkflowActions.tsx"));
const localResult = stripComments(read("components", "tools", "ResultActions.tsx"));
const jobPanel = stripComments(read("components", "jobs", "JobStatePanel.tsx"));
const jobTransfer = stripComments(read("components", "jobs", "jobResultTransfer.ts"));
const jobSaveRoute = stripComments(
  read("app", "api", "jobs", "[id]", "save-to-workspace", "route.ts"),
);
const saveTargetRoute = stripComments(
  read("app", "api", "workflow", "save-target", "route.ts"),
);
const saveTarget = stripComments(
  read("src", "application", "services", "workspaceSaveTarget.ts"),
);
const workspaceService = stripComments(
  read("src", "application", "services", "WorkspaceService.ts"),
);
const processorHook = stripComments(read("hooks", "usePdfProcessor.ts"));
const uploadRoute = stripComments(
  read("app", "api", "workspaces", "[workspaceId]", "documents", "upload", "route.ts"),
);

const READY = { resultAvailable: true, destination: "ready" as SaveDestination };

describe("T6/T7 — the actions a result offers agree with the capability record", () => {
  it("T7 offers both actions to every tool whose output is an editor-openable PDF", () => {
    // Over the whole matrix, not a sample: a tool added tomorrow is covered by
    // this test the moment it is registered.
    for (const capability of TOOL_CAPABILITIES) {
      const actions = resultWorkflowActions({
        capability,
        outputMimeType: null,
        ...READY,
      });
      expect(actions.openInEditor, capability.slug).toBe(capability.editorOpenableOutput);
      expect(actions.saveToWorkspace, capability.slug).toBe(capability.workspaceSaveableOutput);
    }
  });

  it("T6 hides both actions for output that is not a single readable PDF", () => {
    // The three real cases, named: an archive of page images is not a document,
    // and a .docx is not one this editor can open.
    for (const slug of ["pdf-to-jpg", "pdf-to-png", "pdf-to-word"]) {
      const capability = capabilityForSlug(slug);
      expect(capability?.multiOutput || capability?.outputKind !== "pdf", slug).toBe(true);
      const actions = resultWorkflowActions({ capability, outputMimeType: null, ...READY });
      expect(actions, slug).toEqual({
        openInEditor: false,
        saveToWorkspace: false,
        signInToSave: false,
      });
    }
  });

  it("C5 hides Open in Editor for a PDF the editor cannot parse, and KEEPS the Workspace", () => {
    // `protect-pdf` produces a real, ENCRYPTED PDF. The editor cannot parse it;
    // Workspace ingestion never tries to, so the destination stands. This used to
    // assert `saveToWorkspace: false` — which was the editor's answer wearing the
    // Workspace's name.
    const capability = capabilityForSlug("protect-pdf");
    expect(capability?.outputKind).toBe("pdf");
    expect(resultWorkflowActions({ capability, outputMimeType: null, ...READY })).toEqual({
      openInEditor: false,
      saveToWorkspace: true,
      signInToSave: false,
    });
    // Signed out, the same tool offers the truthful stand-in rather than nothing.
    expect(
      resultWorkflowActions({ capability, outputMimeType: null, ...READY, destination: "guest" }),
    ).toEqual({ openInEditor: false, saveToWorkspace: false, signInToSave: true });
  });

  it("C7 lets the RUN's MIME withdraw the Workspace action too, not only the editor", () => {
    const capability = capabilityForSlug("merge-pdf");
    // Both save routes answer 415 for a non-PDF output, so both CTAs must go.
    expect(
      resultWorkflowActions({ capability, outputMimeType: "image/jpeg", ...READY }),
    ).toEqual({ openInEditor: false, saveToWorkspace: false, signInToSave: false });
    expect(
      resultWorkflowActions({
        capability,
        outputMimeType: "image/jpeg",
        ...READY,
        destination: "guest",
      }),
    ).toEqual({ openInEditor: false, saveToWorkspace: false, signInToSave: false });
  });

  it("T6 believes the RUN's own MIME type over the tool's general one", () => {
    const capability = capabilityForSlug("merge-pdf");
    expect(
      resultWorkflowActions({ capability, outputMimeType: PDF_MIME, ...READY }).openInEditor,
    ).toBe(true);
    // A pdf-producing tool that reported a zip for this run offers nothing: the
    // capability describes the tool, the MIME describes what is on screen.
    expect(
      resultWorkflowActions({ capability, outputMimeType: "application/zip", ...READY })
        .openInEditor,
    ).toBe(false);
  });

  it("T6 withdraws both actions when the bytes are gone", () => {
    // An expired server result. Both actions need the bytes, so both go with
    // them — never a button that fails when pressed.
    const capability = capabilityForSlug("compress-pdf");
    expect(
      resultWorkflowActions({
        capability,
        outputMimeType: PDF_MIME,
        resultAvailable: false,
        destination: "ready",
      }),
    ).toEqual({ openInEditor: false, saveToWorkspace: false, signInToSave: false });
  });

  it("T7 offers nothing at all when the surface cannot name its tool", () => {
    // No capability record means no evidence. Defaulting to "show it" is how a
    // conversion tool acquires an editor button.
    expect(
      resultWorkflowActions({ capability: null, outputMimeType: PDF_MIME, ...READY }),
    ).toEqual({ openInEditor: false, saveToWorkspace: false, signInToSave: false });
  });

  it("T7 leaves the surfaces no room to hold their own opinion", () => {
    // Neither result surface may name a tool or an output kind: every condition
    // has to arrive through the capability record.
    for (const [name, source] of [
      ["ResultActions", localResult],
      ["JobStatePanel", jobPanel],
    ] as const) {
      expect(source, name).toContain("<ResultWorkflowActions");
      expect(source, name).not.toContain("editorOpenableOutput");
      expect(source, name).not.toMatch(/pdf-to-|merge-pdf|protect-pdf|compress-pdf/);
      expect(source, name).not.toContain("Open in Editor");
    }
    // And the shared component asks the registry rather than taking a list.
    expect(shared).toContain("capabilityForSlug(toolSlug)");
    expect(shared).toContain(
      "const workflowInput = { capability, outputMimeType, resultAvailable, destination };",
    );
    expect(shared).toContain("resultWorkflowActions(workflowInput)");
  });
});

describe("T20 — the auth boundary offers a route in, never a silent upload", () => {
  it("offers sign-in instead of Save when nobody is signed in, and returns to the tool", () => {
    const capability = capabilityForSlug("merge-pdf");
    const guest = resultWorkflowActions({
      capability,
      outputMimeType: PDF_MIME,
      resultAvailable: true,
      destination: "guest",
    });
    expect(guest).toEqual({ openInEditor: true, saveToWorkspace: false, signInToSave: true });
    // The result is on the page the user came from, so that is where they return.
    expect(signInHref("merge-pdf")).toBe("/login?next=%2Ftools%2Fmerge-pdf");
    expect(signInHref(null)).toBe("/login?next=%2Ftools");
  });

  it("offers no Save while the destination is unknown, and none when there is none", () => {
    const capability = capabilityForSlug("merge-pdf");
    for (const destination of ["loading", "none"] as SaveDestination[]) {
      const actions = resultWorkflowActions({
        capability,
        outputMimeType: PDF_MIME,
        resultAvailable: true,
        destination,
      });
      expect(actions.saveToWorkspace, destination).toBe(false);
      expect(actions.signInToSave, destination).toBe(false);
      // Open in Editor survives both: it needs no Workspace and no account.
      expect(actions.openInEditor, destination).toBe(true);
    }
  });

  it("never uploads on the way to the sign-in page", () => {
    // The whole point of `signInToSave`: the file is not stashed on a server so
    // it can survive a login. It stays where it is and the user comes back.
    const signIn = shared.slice(shared.indexOf("actions.signInToSave ?"));
    expect(signIn).toContain("href={signInHref(toolSlug)}");
    expect(signIn).not.toContain("save(");
    expect(signIn).not.toContain("fetch(");
  });

  it("takes the destination from the server, never from a client-named Workspace", () => {
    // The client asks WHERE it may write; it does not decide. The save routes
    // re-check membership for whatever comes back regardless.
    expect(shared).toContain('fetch("/api/workflow/save-target"');
    // The lookup takes NO input: the session resolves the destination, so there
    // is no `workspaceId` in the request for a caller to get wrong or to lie
    // about. The route reads nothing off the request at all.
    expect(saveTargetRoute).toContain("resolveSaveDestinations(user.id)");
    expect(saveTargetRoute).not.toContain("workspaceId");
    expect(saveTargetRoute).not.toContain("request.");
    expect(jobSaveRoute).toContain("getWorkspaceActor(request, organizationId)");
    expect(jobSaveRoute).toContain("uploads.uploadToWorkspace(actorResult.actor, workspaceId, {");
    // Both authorizations, independently: the job's owner and the destination's
    // membership. Neither implies the other.
    expect(jobSaveRoute).toContain("resolveJobActor()");
    expect(jobSaveRoute).toContain("processingJobService().getResult(id, jobActor)");
    expect(jobSaveRoute).toContain("requireSameOrigin(request)");
  });
});

describe("T2/T21 — a local result reaches the editor without leaving the browser", () => {
  it("hands the bytes over through this browser's own store", () => {
    expect(shared).toContain("const bytes = await loadBytes();");
    expect(shared).toContain("const id = await createHandoff({");
    // The id, not the bytes, is what travels in the URL.
    expect(shared).toContain("router.push(`/editor?handoff=${encodeURIComponent(id)}`)");
    expect(shared).not.toContain("base64");
  });

  it("T21 sends nothing to a server on the local path", () => {
    // The privacy invariant of every browser tool, held at the one place the
    // result could have been uploaded: the local surface's two ports read the
    // blob it already holds, and only `save` — the button the user presses —
    // talks to a route.
    expect(localResult).toContain(
      "loadBytes={async () => new Uint8Array(await result.blob.arrayBuffer())}",
    );
    const openHandler = shared.slice(
      shared.indexOf("const onOpenInEditor"),
      shared.indexOf("const onSave"),
    );
    expect(openHandler).toContain("createHandoff({");
    expect(openHandler).not.toContain("fetch(");
    expect(openHandler).not.toContain("save(");
  });

  it("T2 carries provenance and no document content into the handoff", () => {
    const handoff = shared.slice(
      shared.indexOf("const id = await createHandoff({"),
      shared.indexOf("router.push("),
    );
    expect(handoff).toContain("toolSlug,");
    expect(handoff).toContain("sourceFileNames: [...sourceFileNames],");
    expect(handoff).toContain("fileName,");
  });
});

describe("T3/T4/T5 — the transports differ where the journeys differ", () => {
  it("T3 uploads a local result through the endpoint the editor's first save uses", () => {
    // No dedicated "save result" route: this one already carries CSRF,
    // membership, org scoping, the ceiling and checksum dedup.
    expect(localResult).toContain(
      "fetch(`/api/workspaces/${encodeURIComponent(target.workspaceId)}/documents/upload`",
    );
    expect(localResult).toContain('form.append("file", result.blob, result.fileName);');
    expect(localResult).toContain('form.append("organizationId", target.organizationId);');
  });

  it("T4 saves a cloud result without the bytes touching the browser", () => {
    // Two ids and nothing else. A signed output URL is not sent, so it cannot be
    // copied from one session into another's save.
    expect(jobTransfer).toContain("/save-to-workspace`");
    expect(jobTransfer).toContain("workspaceId: target.workspaceId,");
    expect(jobTransfer).toContain("organizationId: target.organizationId,");
    // Scoped to the save: the OTHER function in this module reads the bytes on
    // purpose, for `Open in Editor`, and the two journeys are the point.
    const saveFn = jobTransfer.slice(jobTransfer.indexOf("export function saveJobResultToWorkspace"));
    expect(saveFn).not.toContain("arrayBuffer");
    expect(saveFn).not.toContain("inline=1");
    expect(jobSaveRoute).not.toContain("getUrl(");
    // The bytes move storage-to-storage, inside the server.
    expect(jobSaveRoute).toContain("await storage.get(output.key)");
  });

  it("T4 refuses a result that cannot honestly become one document", () => {
    // The server half of T6. A hidden button is not an authorization check, and
    // an archive of page images stored as a "document" is a lie about what the
    // user has.
    expect(jobSaveRoute).toContain('output.mimeType !== "application/pdf"');
    expect(jobSaveRoute).toContain('"UNSUPPORTED_OUTPUT"');
    expect(jobSaveRoute).toContain("output.bytes > DOCUMENT_INGESTION_LIMITS.maxUploadBytes");
  });

  it("T5 streams a cloud result to the page from this origin, and keeps download a redirect", () => {
    // `?inline=1` rather than the 302: following the redirect would need bucket
    // CORS in production while working in development, and would put a signed
    // storage URL in the browser.
    expect(jobTransfer).toContain("result?inline=1");
    expect(jobPanel).toContain("loadBytes={() => loadJobResultBytes(job.id)}");
    expect(jobPanel).toContain("save={(target) => saveJobResultToWorkspace(job.id, target)}");
  });
});

describe("T19 — saving the same result twice does not make a second document", () => {
  it("starts a save only from a state that has not saved", () => {
    expect(shouldStartSave({ kind: "idle" })).toBe(true);
    expect(shouldStartSave({ kind: "error", message: "x" })).toBe(true);
    expect(shouldStartSave({ kind: "saving" })).toBe(false);
    expect(shouldStartSave({ kind: "saved", documentId: "d1", href: "/x" })).toBe(false);
  });

  it("guards the double click before the first await, and replaces the button once saved", () => {
    // The state check cannot catch two clicks in one tick — both read the same
    // render. The ref is set synchronously.
    expect(shared).toContain("const savingRef = useRef(false);");
    expect(shared).toContain(
      "if (!target || savingRef.current || !shouldStartSave(saveState)) return;",
    );
    expect(shared.indexOf("savingRef.current = true;")).toBeLessThan(
      shared.indexOf("const res = await save(target);"),
    );
    // After a save the control is a link to the document, not a second Save.
    expect(shared).toContain(
      '(actions.saveToWorkspace || choosing) && saveState.kind !== "saved"',
    );
    expect(shared).toContain("Open document");
  });

  it("links a saved result to the document the server named", () => {
    const target = { workspaceId: "w1", organizationId: "o1", workspaceName: "W" };
    expect(savedDocumentHref(target, "d1")).toBe(
      "/workspaces/w1/documents/d1?organizationId=o1",
    );
    // A dedup response with no document id still lands somewhere real.
    expect(savedDocumentHref(target, null)).toBe("/workspaces/w1?organizationId=o1");
  });

  it("reports a failure without leaving the state unsaveable", () => {
    // A failed save is retryable by the same button: `error` is a starting state.
    const states: ResultSaveState[] = [
      { kind: "error", message: "x" },
      { kind: "saved", documentId: null, href: "/x" },
    ];
    expect(states.map(shouldStartSave)).toEqual([true, false]);
    expect(shared).toContain("savingRef.current = false;");
  });
});

describe("C1-C4 — a member of several Workspaces chooses one before anything is saved", () => {
  const merge = capabilityForSlug("merge-pdf");
  const ws = (id: string): ResultSaveTarget => ({
    workspaceId: id,
    organizationId: "o1",
    workspaceName: `W-${id}`,
  });

  it("C3 selects the only destination there is, and C1 selects none of several", () => {
    // The whole bug in one function. One Workspace is not a decision, so making
    // the user make it is friction; two IS one, and answering it for them is what
    // put documents in the wrong Workspace and left the user to move them.
    expect(resolveInitialSelection([ws("w1")])).toBe("w1");
    expect(resolveInitialSelection([])).toBeNull();
    expect(resolveInitialSelection([ws("w1"), ws("w2")])).toBeNull();
    expect(resolveInitialSelection([ws("w1"), ws("w2"), ws("w3")])).toBeNull();
  });

  it("C2 holds Save inert while the choice is open, and releases it once made", () => {
    // `choose` is reached whenever nothing is selected out of a list that has
    // something in it — see the derivation in `ResultWorkflowActions`.
    const open = { capability: merge, outputMimeType: PDF_MIME, resultAvailable: true };
    expect(resultWorkflowActions({ ...open, destination: "choose" })).toEqual({
      openInEditor: true,
      saveToWorkspace: false,
      signInToSave: false,
    });
    expect(awaitingDestinationChoice({ ...open, destination: "choose" })).toBe(true);
    // Chosen. Same input, same tool, Save now startable.
    expect(resultWorkflowActions({ ...open, destination: "ready" }).saveToWorkspace).toBe(true);
    expect(awaitingDestinationChoice({ ...open, destination: "ready" })).toBe(false);
  });

  it("C2 shows no selector for a result that would have no Save button at all", () => {
    // The selector is not its own decision: it asks the same question Save does,
    // so an expired result, a non-PDF run and a multi-output tool each take the
    // selector with them.
    expect(
      awaitingDestinationChoice({
        capability: merge,
        outputMimeType: PDF_MIME,
        resultAvailable: false,
        destination: "choose",
      }),
    ).toBe(false);
    expect(
      awaitingDestinationChoice({
        capability: merge,
        outputMimeType: "application/zip",
        resultAvailable: true,
        destination: "choose",
      }),
    ).toBe(false);
    expect(
      awaitingDestinationChoice({
        capability: capabilityForSlug("pdf-to-jpg"),
        outputMimeType: null,
        resultAvailable: true,
        destination: "choose",
      }),
    ).toBe(false);
    for (const destination of ["loading", "guest", "none", "ready"] as SaveDestination[]) {
      expect(
        awaitingDestinationChoice({
          capability: merge,
          outputMimeType: PDF_MIME,
          resultAvailable: true,
          destination,
        }),
        destination,
      ).toBe(false);
    }
  });

  it("C1/C4 renders the server's list, and can only ever save into a member of it", () => {
    // The selected id is resolved AGAINST the fetched list, so a value the server
    // never offered resolves to no target and `onSave` returns before its first
    // await. The routes re-authorize regardless — this is the UI half.
    expect(shared).toContain(
      "const target = destinations.find((d) => d.workspaceId === selectedWorkspaceId) ?? null;",
    );
    expect(shared).toContain(
      'const destination: SaveDestination = lookup === "ready" && target === null ? "choose" : lookup;',
    );
    expect(shared).toContain("setSelectedWorkspaceId(resolveInitialSelection(offered));");
    // No filtering in the browser: whatever the boundary returned is what is shown.
    expect(shared).toContain("const offered = body.destinations ?? [];");
    expect(shared).not.toMatch(/destinations\.filter\(/);
    // A real label bound to a real select, and the default is named rather than
    // silently applied.
    expect(shared).toContain("<label htmlFor={selectId}");
    expect(shared).toContain("Save to which Workspace?");
    expect(shared).toContain('? " (default)" : ""');
    expect(shared).toContain("disabled={choosing || saveState.kind === \"saving\"}");
    // Only the name reaches the screen. The ids the routes need travel in the
    // request body, not in the option text.
    expect(shared).not.toContain("{destinationOption.organizationId}");
  });

  it("C1 takes the whole authorized set from the application boundary", () => {
    // Membership-, organization- and lifecycle-scoping all happen inside
    // `WorkspaceService.list`; this module adds no filter of its own and the route
    // adds no input.
    expect(saveTarget).toContain(".list(");
    expect(saveTarget).toContain("organizationDefaultWorkspaceId: org.defaultWorkspaceId,");
    expect(workspaceService).toContain("actorUserId: actor.userId,");
    expect(workspaceService).toContain('lifecycleState: "active",');
    expect(saveTargetRoute).toContain("resolveSaveDestinations(user.id)");
    expect(saveTargetRoute).toContain("destinations, defaultWorkspaceId");
    // A default the actor cannot reach is not labelled as one.
    expect(saveTarget).toContain("destinations.some((d) => d.workspaceId === org.defaultWorkspaceId)");
  });
});

/**
 * D21/D22 — where the save INTENTION is minted, and where it is not.
 *
 * The key is only worth having if it is attached to the result rather than to the
 * component showing it: a key minted in a render is a new intention on every
 * remount, which is a second document for the retry it was supposed to absorb.
 * `lib/workflow/saveIntent.test.ts` proves the helpers behave; this proves the
 * surfaces call them in the one place that makes them true.
 */
describe("D21/D22 — one key per result, sent only when the user saves", () => {
  it("mints it with the result, not on the way to the screen", () => {
    // Beside `setResult` — the moment the bytes exist. Nothing in the render path
    // and nothing per-press, so a remount reuses the key it already has.
    expect(processorHook).toContain("saveIntentKey: newSaveIntentKey(),");
    expect(processorHook.match(/newSaveIntentKey\(\)/g)).toHaveLength(1);
    // The local surfaces do not mint at all; they forward what the result carries.
    expect(localResult).not.toContain("newSaveIntentKey(");
    expect(shared).not.toContain("newSaveIntentKey(");
  });

  it("keeps a local result private until Save, and sends the key in the body", () => {
    // The key travels in the form body of the save request. Never in a URL: a
    // query string is logged, refererred and shared, and this one names an
    // operation the user may retry.
    expect(localResult).toContain(
      'form.append("saveIntentKey", saveIntentKeyForTarget(result.saveIntentKey, target.workspaceId));',
    );
    expect(localResult).not.toContain("saveIntentKey=");
    // Exactly one `fetch` on the local surface, inside the save function.
    expect(localResult.match(/fetch\(/g)).toHaveLength(1);
    const beforeSave = localResult.slice(0, localResult.indexOf("function saveLocalResult"));
    expect(beforeSave).not.toContain("fetch(");
  });

  it("narrows the job's key to the destination, and still relays no bytes", () => {
    expect(jobTransfer).toContain(
      "saveIntentKey: saveIntentKeyForTarget(saveIntentKeyForJob(jobId), target.workspaceId),",
    );
    const saveFn = jobTransfer.slice(jobTransfer.indexOf("export function saveJobResultToWorkspace"));
    expect(saveFn).not.toContain("arrayBuffer");
    expect(jobTransfer).not.toContain("saveIntentKey=");
  });

  it("takes the source identity from the server, never from the key's sender", () => {
    // A key says WHICH operation; it never says what the operation is allowed to
    // touch. The job route names the job from its own path parameter, and the
    // upload route defaults the source to a constant rather than to the filename.
    expect(jobSaveRoute).toContain('sourceKind: "processing-job", sourceIdentity: id }');
    expect(uploadRoute).toContain('sourceKind: "local-result"');
    expect(uploadRoute).toContain('optionalField(form, "saveIntentSource") ?? "local-result"');
    expect(uploadRoute).not.toContain("sourceIdentity: name");
  });

  it("does not create a save intention on the way to the editor", () => {
    // Open in Editor is local. It must not claim an identity for a save the user
    // has not asked for — that would make the later, real Save a conflict.
    const openHandler = shared.slice(
      shared.indexOf("const onOpenInEditor"),
      shared.indexOf("const onSave"),
    );
    expect(openHandler).not.toContain("saveIntent");
  });
});
