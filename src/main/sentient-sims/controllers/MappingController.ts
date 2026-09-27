import { Request, Response } from 'express';
import log from 'electron-log';
import { ExportTraitsRequest, MappingService } from '../services/MappingService';

export class MappingController {
  private readonly mapping: MappingService;

  constructor(mapping: MappingService) {
    this.mapping = mapping;
  }

  getTraits = (req: Request, res: Response) => {
    log.debug(`params: ${JSON.stringify(req.query)}`);
    const searchClass: string | undefined = req.query.searchClass as string | undefined;
    const extractedPath: string = req.query.extractedPath as string;

    res.json(
      this.mapping.getTraits({
        searchClass,
        extractedPath,
      }),
    );
  };

  getUnmappedTraits = (req: Request, res: Response) => {
    const searchClass: string | undefined = req.query.searchClass as string | undefined;
    const extractedPath: string = req.query.extractedPath as string;
    res.json(
      this.mapping.getUnmappedTraits({
        searchClass,
        extractedPath,
      }),
    );
  };

  getMoods = (req: Request, res: Response) => {
    res.json(this.mapping.getMoods());
  };

  getUnmappedMoods = (req: Request, res: Response) => {
    res.json(this.mapping.getUnmappedMoods());
  };

  exportTraits = (req: Request, res: Response) => {
    const exportTraitsRequest = req.body as ExportTraitsRequest;
    log.debug(`ExtractedPath: ${exportTraitsRequest.extractedPath}`);
    log.debug(`Length of Traits: ${Object.keys(exportTraitsRequest.traits).length}`);
    this.mapping.exportTraits(exportTraitsRequest);
    res.json({ done: 'done' });
  };
}
