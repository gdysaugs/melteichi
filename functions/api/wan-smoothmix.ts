import {
  onRequestGet as wanRemixGet,
  onRequestOptions as wanRemixOptions,
  onRequestPost as wanRemixPost,
} from './wan_remix'

type SmoothmixEnv = {
  RUNPOD_WAN_SMOOTHMIX_ENDPOINT_URL?: string
  RUNPOD_WAN_REMIX_ENDPOINT_URL?: string
}

const DEFAULT_SMOOTHMIX_ENDPOINT = 'https://api.runpod.ai/v2/09btjq0zper536'

const withSmoothmixEndpoint = <T extends SmoothmixEnv>(env: T): T => {
  const endpoint =
    env?.RUNPOD_WAN_SMOOTHMIX_ENDPOINT_URL ||
    DEFAULT_SMOOTHMIX_ENDPOINT
  return {
    ...env,
    RUNPOD_WAN_REMIX_ENDPOINT_URL: endpoint,
  }
}

export const onRequestOptions: PagesFunction<SmoothmixEnv> = async (context) =>
  wanRemixOptions({ ...context, env: withSmoothmixEndpoint(context.env) } as any)

export const onRequestGet: PagesFunction<SmoothmixEnv> = async (context) =>
  wanRemixGet({ ...context, env: withSmoothmixEndpoint(context.env) } as any)

export const onRequestPost: PagesFunction<SmoothmixEnv> = async (context) =>
  wanRemixPost({ ...context, env: withSmoothmixEndpoint(context.env) } as any)
