import {
  onRequestGet as wanRemixGet,
  onRequestOptions as wanRemixOptions,
  onRequestPost as wanRemixPost,
} from './wan_remix'

type RapidFastmoveEnv = {
  RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL?: string
  RUNPOD_WAN_REMIX_ENDPOINT_URL?: string
}

const DEFAULT_FASTMOVE_ENDPOINT = 'https://api.runpod.ai/v2/h2brgijmo5wlmw'

const withRapidFastmoveEndpoint = <T extends RapidFastmoveEnv>(env: T): T => {
  const endpoint =
    env?.RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL || DEFAULT_FASTMOVE_ENDPOINT
  return {
    ...env,
    RUNPOD_WAN_REMIX_ENDPOINT_URL: endpoint,
  }
}

export const onRequestOptions: PagesFunction<RapidFastmoveEnv> = async (context) =>
  wanRemixOptions({ ...context, env: withRapidFastmoveEndpoint(context.env) } as any)

export const onRequestGet: PagesFunction<RapidFastmoveEnv> = async (context) =>
  wanRemixGet({ ...context, env: withRapidFastmoveEndpoint(context.env) } as any)

export const onRequestPost: PagesFunction<RapidFastmoveEnv> = async (context) =>
  wanRemixPost({ ...context, env: withRapidFastmoveEndpoint(context.env) } as any)
