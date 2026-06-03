import {
  onRequestGet as fluxI2iGet,
  onRequestOptions as fluxI2iOptions,
  onRequestPost as fluxI2iPost,
} from './flux-i2i'

const TURBO_ENDPOINT_URL = 'https://api.runpod.ai/v2/2htqcbpy1uur6m'

const withTurboEndpoint = (context: any) => ({
  ...context,
  env: {
    ...context.env,
    RUNPOD_FLUX_I2I_ENDPOINT_URL: TURBO_ENDPOINT_URL,
    RUNPOD_FLUX_I2I_STEP8_COST_ENABLED: 'true',
  },
})

export const onRequestOptions: PagesFunction = (context) => fluxI2iOptions(withTurboEndpoint(context))

export const onRequestGet: PagesFunction = (context) => fluxI2iGet(withTurboEndpoint(context))

export const onRequestPost: PagesFunction = (context) => fluxI2iPost(withTurboEndpoint(context))
