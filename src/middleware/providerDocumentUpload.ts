import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const providerDocumentStorageRoot = path.resolve(
  process.env.PROVIDER_DOCUMENTS_DIR ||
    path.resolve(process.cwd(), "private-uploads/provider-documents")
);

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const allowedExtensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    try {
      fs.mkdirSync(providerDocumentStorageRoot, { recursive: true });
      callback(null, providerDocumentStorageRoot);
    } catch (error) {
      callback(error as Error, providerDocumentStorageRoot);
    }
  },
  filename: (_req, file, callback) => {
    const extension = allowedExtensions[file.mimetype];
    callback(null, `${randomUUID()}${extension || ".upload"}`);
  },
});

export const uploadProviderDocuments = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 7,
    fields: 30,
    parts: 40,
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new Error("Only PDF, JPG and PNG documents are accepted."));
      return;
    }

    callback(null, true);
  },
}).array("documents", 7);

export async function removeProviderFiles(
  files: Express.Multer.File[] = []
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      if (!file?.path) return;

      try {
        await fs.promises.unlink(file.path);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;

        if (code !== "ENOENT") {
          console.error("Unable to remove temporary provider document:", error);
        }
      }
    })
  );
}
