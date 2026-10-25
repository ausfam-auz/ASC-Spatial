import {
  ListScansResponse,
  UploadScanBody,
  UploadScanResponse,
} from "@workspace/api-zod";
import {
  db,
  scanMetadataTable,
  scanUploadRateLimitsTable,
  usersTable,
} from "@workspace/db";
import { Storage } from "@google-cloud/storage";
import { sql, desc, eq } from "drizzle-orm";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer, { type StorageEngine } from "multer";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { isWorkspaceAdmin } from "../middlewares/requireAdmin";

const STORAGE_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${STORAGE_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${STORAGE_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const UPLOAD_RATE_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_RATE_LIMIT = 20;
const ALLOWED_EXTENSIONS = new Set([".ply", ".obj"]);

class InvalidScanFileError extends Error {
  constructor() {
    super("Only .ply and .obj files are accepted");
    this.name = "InvalidScanFileError";
  }
}

class StorageUploadError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = "StorageUploadError";
  }
}

function parsePrivateDirectory(): {
  bucketName: string;
  prefix: string;
} {
  const rawPath = process.env.PRIVATE_OBJECT_DIR;
  if (!rawPath) {
    throw new Error("App Storage is not configured: PRIVATE_OBJECT_DIR is missing");
  }

  const parts = rawPath.split("/").filter(Boolean);
  const bucketName = parts.shift();
  if (!bucketName || parts.length === 0) {
    throw new Error("App Storage private directory has an invalid format");
  }

  return { bucketName, prefix: parts.join("/") };
}

function getIdleTimeoutMs(): number {
  const value = Number(process.env.SCAN_UPLOAD_IDLE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_IDLE_TIMEOUT_MS;
}

class AppStorageStreamEngine implements StorageEngine {
  _handleFile(
    req: Request,
    file: Express.Multer.File,
    callback: (
      error?: Error | null,
      info?: Partial<Express.Multer.File>,
    ) => void,
  ): void {
    let destination: string;
    let objectName: string;

    try {
      const { bucketName, prefix } = parsePrivateDirectory();
      destination = bucketName;
      objectName = `${prefix}/asc-spatial-scans/${randomUUID()}${extname(file.originalname).toLowerCase()}`;
    } catch (error) {
      callback(error instanceof Error ? error : new Error("App Storage configuration failed"));
      return;
    }

    const objectFile = objectStorageClient.bucket(destination).file(objectName);
    let settled = false;
    let idleTimer: NodeJS.Timeout;
    let fileSize = 0;
    const idleTimeoutMs = getIdleTimeoutMs();

    const finish = (
      error?: Error | null,
      info?: Partial<Express.Multer.File>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      callback(error, info);
    };

    const logAndCleanup = (error: Error) => {
      const tooLarge =
        error instanceof multer.MulterError &&
        error.code === "LIMIT_FILE_SIZE";
      const timedOut =
        error instanceof StorageUploadError
          ? error.timedOut
          : /ETIMEDOUT|ECONNRESET|EAI_AGAIN|timeout/i.test(error.message);

      if (tooLarge) {
        req.log.warn(
          { objectPath: `/objects/asc-spatial-scans/${objectName.split("/").at(-1)}` },
          "Scan upload exceeded the 100 MiB file limit",
        );
      } else {
        req.log.error(
          {
            errorName: error.name,
            errorCode: "code" in error ? error.code : undefined,
            networkTimeout: timedOut,
            objectPath: `/objects/asc-spatial-scans/${objectName.split("/").at(-1)}`,
          },
          timedOut
            ? "App Storage upload timed out on the network"
            : "App Storage upload stream failed",
        );
      }

      void objectFile
        .delete({ ignoreNotFound: true })
        .catch((cleanupError: unknown) => {
          req.log.warn(
            {
              errorName:
                cleanupError instanceof Error
                  ? cleanupError.name
                  : "UnknownError",
            },
            "Could not remove incomplete scan object",
          );
        })
        .finally(() =>
          finish(
            error instanceof StorageUploadError ||
              error instanceof multer.MulterError
              ? error
              : new StorageUploadError(
                  timedOut
                    ? "App Storage upload timed out"
                    : "App Storage upload failed",
                  timedOut,
                ),
          ),
        );
    };

    const writeStream = objectFile.createWriteStream({
      resumable: true,
      validation: "crc32c",
      metadata: {
        contentType: file.mimetype || "application/octet-stream",
        metadata: { source: "asc-spatial-scans" },
      },
    });

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const timeoutError = new StorageUploadError(
          `No upload progress for ${idleTimeoutMs} ms`,
          true,
        );
        file.stream.unpipe(writeStream);
        writeStream.destroy(timeoutError);
      }, idleTimeoutMs);
    };

    resetIdleTimer();
    file.stream.on("data", (chunk: Buffer | string) => {
      fileSize += Buffer.byteLength(chunk);
      resetIdleTimer();
    });
    file.stream.once("limit", () => {
      writeStream.destroy(new multer.MulterError("LIMIT_FILE_SIZE"));
    });
    file.stream.once("error", (error: Error) => {
      writeStream.destroy(error);
    });
    writeStream.once("error", logAndCleanup);
    writeStream.once("finish", () => {
      const filename = objectName.split("/").at(-1) ?? objectName;
      finish(null, {
        destination,
        filename: objectName,
        path: `/objects/asc-spatial-scans/${filename}`,
        size: fileSize,
      });
    });

    file.stream.pipe(writeStream);
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    if (!file.destination || !file.filename) {
      callback(null);
      return;
    }

    void objectStorageClient
      .bucket(file.destination)
      .file(file.filename)
      .delete({ ignoreNotFound: true })
      .then(() => callback(null))
      .catch((error: Error) => callback(error));
  }
}

const storage = new AppStorageStreamEngine();
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 8, fieldSize: 4096 },
  fileFilter: (req, file, callback) => {
    const extension = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      req.log.warn(
        { extension: extension || "(none)" },
        "Rejected scan upload with an unsupported file extension",
      );
      callback(new InvalidScanFileError());
      return;
    }
    callback(null, true);
  },
});

const router: IRouter = Router();

router.get(
  "/v1/scans",
  requireTechnician,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.dbUser) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const scans = await db
        .select({
          id: scanMetadataTable.id,
          moduleType: scanMetadataTable.moduleType,
          technicianId: scanMetadataTable.technicianId,
          timestamp: scanMetadataTable.timestamp,
          vesselAssetName: scanMetadataTable.vesselAssetName,
          fileName: scanMetadataTable.fileName,
          fileSize: scanMetadataTable.fileSize,
          uploadedAt: scanMetadataTable.uploadedAt,
        })
        .from(scanMetadataTable)
        .where(eq(scanMetadataTable.uploadedBy, req.dbUser.id))
        .orderBy(desc(scanMetadataTable.uploadedAt))
        .limit(50);

      res.json(ListScansResponse.parse({ scans }));
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(error.message);
      req.log.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          networkTimeout: isTimeout,
        },
        "Failed to load recent technician scans",
      );
      res.status(503).json({ error: "Scan history is temporarily unavailable" });
    }
  },
);

async function requireTechnician(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.dbUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [user] = await db
      .select({ isTechnician: usersTable.isTechnician })
      .from(usersTable)
      .where(eq(usersTable.id, req.dbUser.id))
      .limit(1);

    if (!user?.isTechnician && !isWorkspaceAdmin(req.dbUser.email)) {
      res.status(403).json({ error: "Technician account is not approved" });
      return;
    }
    next();
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Could not verify technician permissions",
    );
    res.status(503).json({ error: "Could not verify upload permissions" });
  }
}

async function applyScanUploadRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.dbUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const now = new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / UPLOAD_RATE_WINDOW_MS) *
      UPLOAD_RATE_WINDOW_MS,
  );

  try {
    const [entry] = await db
      .insert(scanUploadRateLimitsTable)
      .values({
        technicianId: req.dbUser.id,
        windowStart,
        requestCount: 1,
      })
      .onConflictDoUpdate({
        target: scanUploadRateLimitsTable.technicianId,
        set: {
          windowStart,
          requestCount: sql`CASE
            WHEN ${scanUploadRateLimitsTable.windowStart} < ${windowStart}
              THEN 1
            ELSE ${scanUploadRateLimitsTable.requestCount} + 1
          END`,
        },
      })
      .returning({ requestCount: scanUploadRateLimitsTable.requestCount });

    if (entry.requestCount > UPLOAD_RATE_LIMIT) {
      const retryAfter = Math.max(
        1,
        Math.ceil(
          (windowStart.getTime() + UPLOAD_RATE_WINDOW_MS - Date.now()) / 1000,
        ),
      );
      req.log.warn(
        { limit: UPLOAD_RATE_LIMIT, windowSeconds: UPLOAD_RATE_WINDOW_MS / 1000 },
        "Technician scan upload rate limit exceeded",
      );
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Upload rate limit exceeded" });
      return;
    }

    next();
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Scan upload rate-limit check failed",
    );
    res.status(503).json({ error: "Upload protection is temporarily unavailable" });
  }
}

function parseMultipart(
  req: Request,
  res: Response,
  next: (error?: unknown) => void,
): void {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      req.log.warn(
        { multerCode: error.code },
        tooLarge ? "Scan upload exceeded the 100 MiB file limit" : "Invalid scan multipart request",
      );
      res
        .status(tooLarge ? 413 : 400)
        .json({ error: tooLarge ? "File exceeds the 100 MiB limit" : error.message });
      return;
    }

    if (error instanceof InvalidScanFileError) {
      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof StorageUploadError) {
      res
        .status(503)
        .json({ error: error.timedOut ? "Storage upload timed out" : "Storage service unavailable" });
      return;
    }

    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Scan upload could not be stored",
    );
    res.status(503).json({ error: "Storage service unavailable" });
  });
}

async function removeStoredObject(file: Express.Multer.File): Promise<void> {
  if (!file.destination || !file.filename) return;
  await objectStorageClient
    .bucket(file.destination)
    .file(file.filename)
    .delete({ ignoreNotFound: true });
}

router.post(
  "/v1/scan/upload",
  requireTechnician,
  applyScanUploadRateLimit,
  parseMultipart,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.dbUser) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "A .ply or .obj file is required" });
      return;
    }

    const parsed = UploadScanBody.omit({ file: true }).safeParse(req.body);
    if (!parsed.success) {
      await removeStoredObject(req.file).catch((error: unknown) => {
        req.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Failed to remove scan after metadata validation error",
        );
      });
      req.log.warn({ validationError: parsed.error.message }, "Invalid scan metadata");
      res.status(400).json({ error: "Invalid scan metadata" });
      return;
    }

    if (parsed.data.technicianId !== req.dbUser.id) {
      await removeStoredObject(req.file).catch((error: unknown) => {
        req.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Failed to remove scan with technician identity mismatch",
        );
      });
      res.status(403).json({
        error: "Technician ID must match the authenticated account ID",
      });
      return;
    }

    let bucketName: string;
    try {
      bucketName = parsePrivateDirectory().bucketName;
    } catch (error) {
      await removeStoredObject(req.file).catch(() => undefined);
      req.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "App Storage configuration is unavailable",
      );
      res.status(503).json({ error: "Storage service unavailable" });
      return;
    }

    const storedFile = req.file as Express.Multer.File & {
      destination: string;
      filename: string;
      path: string;
      size: number;
    };
    const storageUrl = `https://storage.googleapis.com/${bucketName}/${storedFile.filename}`;

    try {
      const [record] = await db
        .insert(scanMetadataTable)
        .values({
          moduleType: parsed.data.moduleType,
          technicianId: parsed.data.technicianId,
          timestamp: parsed.data.timestamp,
          vesselAssetName: parsed.data.vesselAssetName,
          storageUrl,
          objectPath: storedFile.path,
          fileName: req.file.originalname,
          fileSize: storedFile.size,
          uploadedBy: req.dbUser.id,
        })
        .returning({ id: scanMetadataTable.id });

      res.status(200).json(UploadScanResponse.parse({ id: record.id }));
    } catch (error) {
      await removeStoredObject(req.file).catch((cleanupError: unknown) => {
        req.log.error(
          { errorName: cleanupError instanceof Error ? cleanupError.name : "UnknownError" },
          "Failed to remove scan after database insert failure",
        );
      });
      const isTimeout =
        error instanceof Error &&
        /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(error.message);
      req.log.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          networkTimeout: isTimeout,
        },
        isTimeout
          ? "Database operation timed out during scan upload"
          : "Failed to save scan metadata",
      );
      res
        .status(isTimeout ? 503 : 500)
        .json({ error: isTimeout ? "Database operation timed out" : "Could not save scan metadata" });
    }
  },
);

export default router;
