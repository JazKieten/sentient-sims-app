import { Request, Response } from 'express';
import log from 'electron-log';
import { ApiContext } from '../services/ApiContext';
import { MappingReviewRequest } from '../models/MappingReview';

export class MappingReviewController {
  private readonly ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  // After Test in the mapping dialogs: the template and the narrated samples, read against the
  // mapping guidelines. A provider failure still answers 200 with the app's own checks.
  reviewMapping = async (req: Request, res: Response) => {
    const body = req.body as Partial<MappingReviewRequest>;
    if (typeof body.action !== 'string' || (body.kind !== 'interaction' && body.kind !== 'animation')) {
      res.status(400).json({ error: 'A review needs a kind and an action' });
      return;
    }
    try {
      res.json(await this.ctx.mappingReview.review(body as MappingReviewRequest));
    } catch (err) {
      log.error('[Controller] Error reviewing a mapping:', err);
      res.status(500).json({ error: 'The mapping could not be reviewed.' });
    }
  };
}
