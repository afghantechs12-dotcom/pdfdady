"use client";

import { useEffect, useState } from "react";
import { FormInput } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { ResultActions } from "@/components/tools/ResultActions";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { useFileUpload } from "@/hooks/useFileUpload";
import { usePdfProcessor } from "@/hooks/usePdfProcessor";
import {
  readFormFields,
  fillFormFields,
  type FormFieldInfo,
  type FormValue,
} from "@/lib/pdf/forms";

export function FillFormsTool() {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const proc = usePdfProcessor({ fileCount: upload.files.length });
  const file = upload.files[0];

  const [fields, setFields] = useState<FormFieldInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [flatten, setFlatten] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!file) {
      setFields(null);
      setValues({});
      setLoadError(null);
      return;
    }
    readFormFields(file)
      .then((fs) => {
        if (!active) return;
        setFields(fs);
        const initial: Record<string, FormValue> = {};
        fs.forEach((f) => {
          initial[f.name] = {
            name: f.name,
            type: f.type,
            value: f.value ?? "",
            checked: f.checked ?? false,
          };
        });
        setValues(initial);
      })
      .catch((err) => {
        if (active) setLoadError(err?.message ?? "Could not read the PDF.");
      });
    return () => {
      active = false;
    };
  }, [file]);

  if (proc.status === "done" && proc.result) {
    return (
      <ResultActions
        result={proc.result}
        onReset={() => {
          proc.reset();
          upload.reset();
          setFields(null);
        }}
      />
    );
  }

  const fillable = fields?.filter((f) => f.type !== "unsupported") ?? [];

  return (
    <div>
      <UploadDropzone
        accept={["application/pdf"]}
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={(i) => {
          upload.removeFile(i);
          setFields(null);
        }}
        title="Drop your PDF form here"
        subtitle="or click to browse"
        acceptHint="Select one PDF with form fields · Max 50MB"
      />

      {loadError && <ErrorBanner message={loadError} />}

      {file && fields !== null && fields.length === 0 && (
        <p className="mt-6 rounded-xl border border-softborder bg-lavender/40 px-4 py-3 text-sm text-navy-soft">
          This PDF has no interactive form fields to fill. Try the Edit or Sign
          tools instead.
        </p>
      )}

      {fillable.length > 0 && (
        <div className="mt-6 space-y-3 rounded-xl border border-softborder bg-lavender/40 p-4">
          <p className="text-sm font-medium text-navy">
            {fillable.length} form field{fillable.length === 1 ? "" : "s"} found
          </p>
          {fillable.map((field) => (
            <div key={field.name}>
              {field.type === "checkbox" ? (
                <label className="flex items-center gap-2 text-sm text-navy">
                  <input
                    type="checkbox"
                    checked={values[field.name]?.checked ?? false}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [field.name]: {
                          ...v[field.name],
                          checked: e.target.checked,
                        },
                      }))
                    }
                    className="h-4 w-4 rounded border-softborder text-primary focus:ring-primary"
                  />
                  {field.name}
                </label>
              ) : field.type === "dropdown" ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-navy">
                    {field.name}
                  </span>
                  <select
                    value={values[field.name]?.value ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [field.name]: {
                          ...v[field.name],
                          value: e.target.value,
                        },
                      }))
                    }
                    className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="">— Select —</option>
                    {field.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-navy">
                    {field.name}
                  </span>
                  <input
                    type="text"
                    value={values[field.name]?.value ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [field.name]: {
                          ...v[field.name],
                          value: e.target.value,
                        },
                      }))
                    }
                    className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </label>
              )}
            </div>
          ))}

          <label className="flex items-center gap-2 pt-1 text-sm text-navy-soft">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(e) => setFlatten(e.target.checked)}
              className="h-4 w-4 rounded border-softborder text-primary focus:ring-primary"
            />
            Flatten form (make values permanent / non-editable)
          </label>
        </div>
      )}

      {proc.status === "error" && proc.error && (
        <ErrorBanner message={proc.error.message} />
      )}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<FormInput size={18} />}
          loading={proc.status === "processing"}
          disabled={fillable.length === 0 || proc.status === "processing"}
          onClick={() =>
            proc.run(
              () => fillFormFields(file, Object.values(values), flatten),
              file,
            )
          }
        >
          {proc.status === "processing" ? "Filling…" : "Fill Form & Download"}
        </Button>
      </div>
    </div>
  );
}
