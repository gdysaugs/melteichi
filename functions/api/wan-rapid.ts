import {
  onRequestGet as wanRemixGet,
  onRequestOptions as wanRemixOptions,
  onRequestPost as wanRemixPost,
} from './wan_remix'

type RapidEnv = {
  RUNPOD_WAN_RAPID_ENDPOINT_URL?: string
  RUNPOD_WAN_REMIX_ENDPOINT_URL?: string
}

const withRapidEndpoint = <T extends RapidEnv>(env: T): T => {
  if (!env?.RUNPOD_WAN_RAPID_ENDPOINT_URL) return env
  return {
    ...env,
    RUNPOD_WAN_REMIX_ENDPOINT_URL: env.RUNPOD_WAN_RAPID_ENDPOINT_URL,
  }
}

export const onRequestOptions: PagesFunction<RapidEnv> = async (context) =>
  wanRemixOptions({ ...context, env: withRapidEndpoint(context.env) } as any)

export const onRequestGet: PagesFunction<RapidEnv> = async (context) =>
  wanRemixGet({ ...context, env: withRapidEndpoint(context.env) } as any)

export const onRequestPost: PagesFunction<RapidEnv> = async (context) =>
  wanRemixPost({ ...context, env: withRapidEndpoint(context.env) } as any)
