// The improver behind the eval page: the same pipeline `npm run improve` runs (gather the inputs,
// judge each failing trace, propose one change, save the proposal under runs/improve/), started by
// a click, and the past proposals listed and read back. It writes nothing outside runs/improve/: a
// person reads the proposal and decides, and the eval measures any change taken from it.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import { cents } from "../../eval/record.js";
import { IMPROVE_DIR, improve, saveImprove, type ImproveRecord } from "../improve/improve.js";
import { ImproveRefused, prepareImprove, type ImproveRequest } from "../improve/prepare.js";
import { apiFailure } from "./api-failure.js";

/** One past proposal in the page's list, newest first. */
export interface ProposalListing {
  improveId: string;
  createdAt: string;
  evalId: string;
  /** The questions whose traces were judged. */
  questions: string[];
  /** What the proposal changes, and where. */
  target: string;
  location: string;
  costUsd: number;
}

/** The improver's proposals under `dir`, newest first; a file that does not parse, or holds only the judgements of a run that failed, is left out. */
export async function listProposals(dir = IMPROVE_DIR): Promise<ProposalListing[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const listings = await Promise.all(
    files.map(async (file) => {
      const r = await readFile(path.join(dir, file), "utf8")
        .then((text) => JSON.parse(text) as ImproveRecord)
        .catch(() => null);
      if (!r?.proposal) return [];
      return [
        {
          improveId: r.improveId,
          createdAt: r.createdAt,
          evalId: r.eval.evalId,
          questions: [...new Set(r.judged.map((j) => j.questionId))],
          target: r.proposal.change.target,
          location: r.proposal.change.location,
          costUsd: r.costUsd,
        },
      ];
    }),
  );
  return listings.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Runs the improver for the page and reads its proposals back. */
@Injectable()
export class ImproveService {
  private readonly logger = new Logger(ImproveService.name);
  // One improver run at a time: each costs about a dollar of the strongest model.
  private running = false;

  /** The past proposals, newest first. */
  list(): Promise<ProposalListing[]> {
    return listProposals();
  }

  /** One proposal's record, as JSON text. */
  async read(improveId: string): Promise<string> {
    try {
      return await readFile(path.join(IMPROVE_DIR, `${improveId}.json`), "utf8");
    } catch {
      throw new NotFoundException(`No proposal ${improveId} under ${IMPROVE_DIR}/.`);
    }
  }

  /** Judges the failing traces of an eval record and proposes one change; the proposal is saved and returned, never applied. */
  async propose(request: ImproveRequest): Promise<ImproveRecord> {
    if (this.running) throw new ConflictException("The improver is already running on a request from this page; wait for its proposal.");
    this.running = true;
    try {
      let inputs;
      try {
        inputs = await prepareImprove(request);
      } catch (error) {
        if (error instanceof ImproveRefused) throw new BadRequestException(error.message);
        throw error;
      }
      let record: ImproveRecord;
      try {
        record = await improve(inputs);
      } catch (error) {
        this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        throw new BadGatewayException(`The improver could not finish, and nothing was saved: ${apiFailure(error)}`);
      }
      const file = await saveImprove(record);
      this.logger.log(`proposal for ${record.eval.evalId}: ${record.judged.length} traces judged, ${cents(record.costUsd)}, saved ${file}`);
      return record;
    } finally {
      this.running = false;
    }
  }
}
