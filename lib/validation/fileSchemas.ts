import { z } from "zod";

export const MAX_SIZE = 50 * 1024 * 1024; // 50MB default

export const pdfFileSchema = z
  .custom<File>((f) => f instanceof File, { message: "Expected a file." })
  .refine((f) => f.type === "application/pdf", {
    message: "Must be a PDF file.",
  })
  .refine((f) => f.size <= MAX_SIZE, { message: "PDF exceeds the 50MB limit." });

export const imageFileSchema = z
  .custom<File>((f) => f instanceof File, { message: "Expected a file." })
  .refine((f) => ["image/jpeg", "image/png"].includes(f.type), {
    message: "Must be a JPG or PNG image.",
  })
  .refine((f) => f.size <= MAX_SIZE, {
    message: "Image exceeds the 50MB limit.",
  });

export const passwordSchema = z
  .string()
  .min(4, "Password must be at least 4 characters.")
  .max(128, "Password is too long.");

export const pageRangeSchema = z
  .object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  })
  .refine((r) => r.from <= r.to, {
    message: "Start page must be less than or equal to end page.",
  });

export const contactSchema = z.object({
  name: z.string().min(1, "Please enter your name."),
  email: z.string().email("Please enter a valid email."),
  message: z.string().min(10, "Message must be at least 10 characters."),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type PageRange = z.infer<typeof pageRangeSchema>;
