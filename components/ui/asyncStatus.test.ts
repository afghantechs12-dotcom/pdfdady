import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncStatus, validProgress } from "./AsyncStatus";
import { EditorOpeningSkeleton } from "@/components/editor/EditorOpeningSkeleton";
import { Button } from "./Button";

describe("truthful asynchronous feedback", () => {
  it("announces the known phase and filename with indeterminate work", () => {
    const html = renderToStaticMarkup(createElement(AsyncStatus, { phase: "pending", message: "Exporting PDF", fileName: "notes.pdf" }));
    expect(html).toContain('role="status"'); expect(html).toContain('aria-busy="true"');
    expect(html).toContain('notes.pdf'); expect(html).toContain('Exporting PDF'); expect(html).not.toContain('<progress');
  });
  it("only supplies a determinate value from valid measured units", () => {
    expect(validProgress({ completed: 2, total: 6, unit: "pages" })).toEqual({ completed: 2, total: 6, unit: "pages" });
    expect(validProgress({ completed: NaN, total: 6, unit: "pages" })).toBeNull();
    expect(validProgress({ completed: 7, total: 6, unit: "pages" })).toBeNull();
    const html = renderToStaticMarkup(createElement(AsyncStatus, { phase: "pending", message: "Rendering pages", progress: { completed: 2, total: 6, unit: "pages" } }));
    expect(html).toContain('value="2"'); expect(html).toContain('max="6"');
  });
  it("keeps errors and document identity visible without claiming cancellation or retry", () => {
    const html = renderToStaticMarkup(createElement(AsyncStatus, { phase: "error", message: "Save failed. Your changes are still here.", fileName: "notes.pdf" }));
    expect(html).toContain('notes.pdf'); expect(html).not.toContain('<button'); expect(html).not.toContain('aria-busy="true"');
  });
  it("reserves page and toolbar structure and labels the real loading phase", () => {
    const html = renderToStaticMarkup(createElement(EditorOpeningSkeleton, { fileName: "notes.pdf" }));
    expect(html).toContain('data-editor-opening="skeleton"'); expect(html).toContain('Preparing editor');
    expect(html).toContain('<aside'); expect(html).toContain('<header'); expect(html).toContain('motion-reduce:animate-none');
    expect(html).not.toContain('<main');
  });
  it("a loading action is functionally disabled even if its caller passes false", () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true, disabled: false, children: "Saving draft" }));
    expect(html).toContain('disabled=""'); expect(html).toContain('aria-busy="true"');
  });
});
