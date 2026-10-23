import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Keep the pinned LittleCMS optimizer's evaluator call type-correct. */
export async function adaptImageSources(source) {
  const file = join(source, "src/vendor/lcms2/src/cmsopt.c")
  const before = await readFile(file, "utf8")
  const include = '#include "lcms2_internal.h"'
  const cast = "_cmsPipelineSetOptimizationParameters(Dest, (_cmsPipelineEval16Fn) DataCLUT->Params->Interpolation.Lerp16, DataCLUT->Params, NULL, NULL);"
  if (before.split(include).length !== 2 || before.split(cast).length !== 2) throw new Error("Pinned LittleCMS interpolation adapter no longer matches")
  // A cmsInterpFunction16 takes const cmsInterpParams*, while the pipeline
  // evaluator takes const void*. Calling through the upstream function cast is
  // undefined C and triggers native function-type instrumentation. Forward to
  // the exact original interpolation function through a correctly typed thunk.
  await writeFile(file, before.replace(include, `${include}

static void ot_image_pipeline_interp16(const cmsUInt16Number input[], cmsUInt16Number output[], const void *data) {
    const cmsInterpParams *parameters = data;
    parameters->Interpolation.Lerp16(input, output, parameters);
}
`).replace(cast, "_cmsPipelineSetOptimizationParameters(Dest, ot_image_pipeline_interp16, DataCLUT->Params, NULL, NULL);"))
}
