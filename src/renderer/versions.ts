import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fetchAuthSession } from 'aws-amplify/auth';
import log from 'electron-log';

/**
 * Reports whether the published artifact differs from the installed mod version.
 *
 * This only checks. It must not install: it runs unprompted from useNewVersionChecker on
 * every mount of UpdateComponent (which lives on the home page), so applying the update
 * here silently overwrote Mods\sentient-sims\sentient-sims.package on app start, and left
 * the "Update now" button permanently disabled because the work was already done. Callers
 * apply updates explicitly via UpdateComponent's Update/Reinstall buttons.
 * Upstream 4.0.6 hit the same bug from the other side: every mounted checker started its own
 * concurrent download and the racing writes corrupted the zip.
 */
export async function isNewVersionAvailable(currentVersionId: string, type = 'main'): Promise<boolean> {
  log.debug(`current version: ${currentVersionId}`);
  try {
    const authSession = await fetchAuthSession();
    const s3Client = new S3Client({
      region: 'us-east-1',
      credentials: authSession.credentials,
    });

    const headObjectCommand = new HeadObjectCommand({
      Bucket: 'sentient-sims-artifacts',
      Key: `sentient-sims-${type}.zip`,
    });

    const response = await s3Client.send(headObjectCommand);

    const latestVersionId = response.Metadata?.version;
    log.debug(`latestVersionId: ${latestVersionId}`);
    if (latestVersionId !== currentVersionId) {
      log.info(`New version available. Current: ${currentVersionId} Latest: ${latestVersionId}`);
      return true;
    }

    return false;
  } catch (error) {
    log.error('Error checking for new version:', error);
    throw error;
  }
}
