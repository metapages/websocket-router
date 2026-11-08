import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";

/**
 * On-disk home for the ACME account key and the issued certificate.
 *
 * Everything is a plain file under `${DATA_DIR}/acme`, owned by the service
 * user and nothing else. Keys are written 0600; losing the directory costs a
 * fresh account registration and a fresh issuance, nothing more.
 */

export type StoredCertificate = {
  readonly key: string;
  readonly cert: string;
};

export type CertificateStore = {
  readonly directory: string;
  readAccountKey: () => Promise<string | null>;
  writeAccountKey: (pem: string) => Promise<void>;
  readCertificate: () => Promise<StoredCertificate | null>;
  writeCertificate: (value: StoredCertificate) => Promise<void>;
};

const KEY_MODE = 0o600;

export const createCertificateStore = (dataDir: string): CertificateStore => {
  const directory = join(dataDir, "acme");
  const accountKeyFile = join(directory, "account.key");
  const certKeyFile = join(directory, "certificate.key");
  const certFile = join(directory, "certificate.crt");

  const readIfPresent = async (file: string): Promise<string | null> => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const writeAtomic = async (file: string, contents: string, mode: number) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, contents, { encoding: "utf8", mode });
    await rename(temp, file);
  };

  return {
    directory,
    readAccountKey: () => readIfPresent(accountKeyFile),
    writeAccountKey: (pem) => writeAtomic(accountKeyFile, pem, KEY_MODE),
    readCertificate: async () => {
      const [key, cert] = await Promise.all([
        readIfPresent(certKeyFile),
        readIfPresent(certFile),
      ]);
      return key && cert ? { key, cert } : null;
    },
    writeCertificate: async ({ key, cert }) => {
      await writeAtomic(certKeyFile, key, KEY_MODE);
      await writeAtomic(certFile, cert, 0o644);
    },
  };
};

/** Days until the leaf certificate expires, or null if it cannot be read. */
export const daysUntilExpiry = (certPem: string): number | null => {
  try {
    const certificate = new X509Certificate(certPem);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validTo)) return null;
    return (validTo - Date.now()) / 86_400_000;
  } catch {
    return null;
  }
};

/** The SANs the certificate actually covers, lowercased. */
export const certificateDomains = (certPem: string): string[] => {
  try {
    const certificate = new X509Certificate(certPem);
    return (certificate.subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).toLowerCase());
  } catch {
    return [];
  }
};
