import { loadPdfDocument } from "./loadDocument";
import { PdfProcessingError, type ProcessedResult } from "./types";

export type FormFieldType = "text" | "checkbox" | "dropdown" | "unsupported";

export interface FormFieldInfo {
  name: string;
  type: FormFieldType;
  options?: string[];
  value?: string;
  checked?: boolean;
}

/** Reads the interactive form fields from a PDF for the fill UI. */
export async function readFormFields(file: File): Promise<FormFieldInfo[]> {
  const { PDFCheckBox, PDFDropdown, PDFTextField } = await import("pdf-lib");
  const doc = await loadPdfDocument(file);
  const form = doc.getForm();
  const fields = form.getFields();

  return fields.map((field): FormFieldInfo => {
    const name = field.getName();

    // Use `instanceof` rather than `field.constructor.name`: the class-name
    // string is mangled by production minification, which silently reduced
    // every field to "unsupported" in built deployments.
    if (field instanceof PDFTextField) {
      return { name, type: "text", value: field.getText() ?? "" };
    }
    if (field instanceof PDFCheckBox) {
      return { name, type: "checkbox", checked: field.isChecked() };
    }
    if (field instanceof PDFDropdown) {
      return {
        name,
        type: "dropdown",
        options: field.getOptions(),
        value: field.getSelected()[0] ?? "",
      };
    }
    return { name, type: "unsupported" };
  });
}

export interface FormValue {
  name: string;
  type: FormFieldType;
  value?: string;
  checked?: boolean;
}

/** Fills the provided values into the PDF form and flattens the result. */
export async function fillFormFields(
  file: File,
  values: FormValue[],
  flatten: boolean,
): Promise<ProcessedResult> {
  const doc = await loadPdfDocument(file);
  const form = doc.getForm();

  if (form.getFields().length === 0) {
    // A precondition on the *document*, not on what the user typed — but it is
    // still the input being unusable for this tool, which is what
    // `invalid_input` means on the server side too. A separate
    // `no_form_fields` category would split one honest bucket for one tool.
    throw new PdfProcessingError(
      "This PDF has no interactive form fields to fill.",
      "invalid_input",
    );
  }

  for (const v of values) {
    try {
      if (v.type === "text") {
        form.getTextField(v.name).setText(v.value ?? "");
      } else if (v.type === "checkbox") {
        const cb = form.getCheckBox(v.name);
        if (v.checked) cb.check();
        else cb.uncheck();
      } else if (v.type === "dropdown" && v.value) {
        form.getDropdown(v.name).select(v.value);
      }
    } catch {
      // Skip fields that can't be set rather than failing the whole job.
    }
  }

  if (flatten) form.flatten();

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "filled.pdf",
    mimeType: "application/pdf",
  };
}
