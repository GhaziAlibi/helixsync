// script → zstd → age (passphrase) → file, and back.
//
// Both ends are blocking `Read`/`Write` chains, so callers run them on a
// blocking thread (`spawn_blocking`), not on the async runtime.
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;

use age::secrecy::SecretString;
use anyhow::{anyhow, Context};

const ZSTD_LEVEL: i32 = 3;

/// scrypt cost of the passphrase, as log2 of N. age's default is picked from
/// how fast the machine is (about one second), which can need 512 MiB to
/// 1 GiB of memory at the start of every backup. A fixed 2^17 needs 128 MiB
/// on any host, and the key is a long random secret (at least 32 characters),
/// not a password a person types.
const SCRYPT_LOG_N: u8 = 17;

/// Largest cost accepted when opening a file (2^20: 1 GiB of memory). Files
/// written by this server use [`SCRYPT_LOG_N`]; the `age` tool itself uses 18.
const SCRYPT_MAX_LOG_N: u8 = 20;

pub type SealWriter<W> = zstd::stream::write::Encoder<'static, age::stream::StreamWriter<W>>;

/// Wraps `out` so that what is written is compressed, then encrypted with
/// `key`. Finish with [`finish_seal`]; a stream that is not finished is
/// truncated and will not open.
///
/// Deriving the age key from the passphrase is deliberately slow (a fraction
/// of a second and 128 MiB), which is why this runs once per file.
pub fn seal<W: Write>(out: W, key: &str) -> io::Result<SealWriter<W>> {
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(key.to_owned()));
    recipient.set_work_factor(SCRYPT_LOG_N);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|e| io::Error::other(format!("could not set up encryption: {e}")))?;
    let encrypted = encryptor.wrap_output(out)?;
    let mut compressed = zstd::stream::write::Encoder::new(encrypted, ZSTD_LEVEL)?;
    // The checksum is what tells a damaged file from a complete one when the
    // content is read back.
    compressed.include_checksum(true)?;
    Ok(compressed)
}

/// Ends the zstd frame and the age stream and hands back the file.
pub fn finish_seal<W: Write>(sealed: SealWriter<W>) -> io::Result<W> {
    sealed.finish()?.finish()
}

/// Opens an encrypted backup for reading its script. Fails for a wrong key,
/// or for something that is not an age file.
pub fn open_reader<R: Read + Send + 'static>(
    input: R,
    key: &str,
) -> anyhow::Result<Box<dyn BufRead + Send>> {
    let decryptor = age::Decryptor::new(input).map_err(|e| match e {
        age::DecryptError::InvalidHeader | age::DecryptError::UnknownFormat => {
            anyhow!("not a HelixSync backup: the file is not an age-encrypted file")
        }
        other => anyhow!("could not read the backup header: {other}"),
    })?;
    if !decryptor.is_scrypt() {
        return Err(anyhow!(
            "not a HelixSync backup: it is not encrypted with a passphrase"
        ));
    }
    let mut identity = age::scrypt::Identity::new(SecretString::from(key.to_owned()));
    identity.set_max_work_factor(SCRYPT_MAX_LOG_N);
    let decrypted = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| match e {
            age::DecryptError::DecryptionFailed | age::DecryptError::NoMatchingKeys => {
                anyhow!("BACKUP_ENCRYPTION_KEY does not open this file (wrong key, or the file is damaged)")
            }
            other => anyhow!("could not decrypt the backup: {other}"),
        })?;
    let decompressed = zstd::stream::read::Decoder::new(decrypted)
        .context("could not start decompressing the backup")?;
    Ok(Box::new(BufReader::with_capacity(256 * 1024, decompressed)))
}

pub fn open_file(path: &Path, key: &str) -> anyhow::Result<Box<dyn BufRead + Send>> {
    let file =
        std::fs::File::open(path).with_context(|| format!("could not open {}", path.display()))?;
    open_reader(BufReader::new(file), key)
}

/// Seals `script` in memory. For tests and tooling that need a backup file
/// without a database.
pub fn seal_bytes(script: &[u8], key: &str) -> io::Result<Vec<u8>> {
    let mut sealed = seal(Vec::new(), key)?;
    sealed.write_all(script)?;
    finish_seal(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "k3Yb0ardCat-9fQ2xVzLmW7pRtN1uHsJ4aEoXyC6dGq8";

    fn read_all(bytes: Vec<u8>, key: &str) -> anyhow::Result<Vec<u8>> {
        let mut out = Vec::new();
        open_reader(io::Cursor::new(bytes), key)?
            .read_to_end(&mut out)
            .map_err(|e| anyhow!("{e}"))?;
        Ok(out)
    }

    #[test]
    fn round_trips() {
        let sealed = seal_bytes(b"hello\nworld\n", KEY).unwrap();
        assert!(!sealed.windows(5).any(|w| w == b"hello"));
        assert_eq!(read_all(sealed, KEY).unwrap(), b"hello\nworld\n");
    }

    #[test]
    fn a_wrong_key_is_refused() {
        let sealed = seal_bytes(b"secret", KEY).unwrap();
        let err = read_all(sealed, "another-key-another-key-another-key-xx").unwrap_err();
        assert!(err.to_string().contains("BACKUP_ENCRYPTION_KEY"), "{err}");
    }

    #[test]
    fn something_that_is_not_a_backup_is_refused() {
        assert!(read_all(b"just some text, not a backup".to_vec(), KEY).is_err());
        assert!(read_all(Vec::new(), KEY).is_err());
    }

    #[test]
    fn truncation_and_tampering_are_detected() {
        let payload: Vec<u8> = (0..200_000u32).flat_map(|n| n.to_le_bytes()).collect();
        let sealed = seal_bytes(&payload, KEY).unwrap();
        assert_eq!(read_all(sealed.clone(), KEY).unwrap(), payload);

        let mut cut = sealed.clone();
        cut.truncate(sealed.len() - 40);
        assert!(read_all(cut, KEY).is_err(), "truncated");

        let mut flipped = sealed.clone();
        let middle = flipped.len() / 2;
        flipped[middle] ^= 0x01;
        assert!(read_all(flipped, KEY).is_err(), "tampered");
    }
}
