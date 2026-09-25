import { api, prepareImage, triggerRun } from './client.js';
import { TASK_SG } from './ai-contracts.js';

/** Adapter into the existing Singapore review/confirm/submit workflow. */
export const configuredSingaporeProvider = {
  id: 'configured-sg', label: 'Singapore configured AI route', kind: 'configured', tier: 'configured', reads_image: true,
  description: 'Uses the Singapore task default from AI Models & Connections. Each run records the actual provider/model and requires human review.',
  cost: 'Provider-reported usage; estimate available only with a complete pricing schedule',
  async analyzePriceImage(image) {
    if (!image.file) throw new Error('Re-add the original image to run recognition.');
    const prepared = await prepareImage(image.file);
    const run = await api('/ai/runs', { task: TASK_SG, image: prepared.processed, width: prepared.width, height: prepared.height, idempotencyKey: crypto.randomUUID() });
    localStorage.setItem(`rei.sg.run.${image.id}`, run.id); triggerRun(run.id);
    const deadline = Date.now() + 320000; // past the server's 300 s run limit, so the answer is the run's own
    while (Date.now() < deadline) {
      const current = await api(`/ai/runs/${run.id}`);
      if (['failed', 'timed_out'].includes(current.state)) throw new Error(`${current.error?.message ?? 'Recognition failed.'}${current.fallbackRunId ? ' A separately recorded fallback is available in AI run history.' : ''}`);
      if (current.state === 'needs_review') {
        const prices = current.result?.prices ?? [];
        if (!prices.length) throw new Error('The model returned no readable prices. Retake the image or enter observations manually.');
        return prices.map((p, index) => ({ raw_text: p.rawText, brand_candidate: null, sku_candidate: p.skuCandidateId, price_candidate: p.priceDecimal == null ? null : Number(p.priceDecimal), confidence: p.score, bounding_box: { x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3] }, alternatives: [], shelf: index + 1, facings: 1, run_id: current.id, provider_model: current.resolvedModelId ?? current.remoteModelId, score_type: p.score == null ? 'none' : 'model_self_report' }));
      }
      if (current.state === 'queued') triggerRun(run.id);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('The wait ended. The durable run is retained on the server; no simulated result was substituted.');
  },
};
