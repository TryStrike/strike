export const AI_ROUTE = '/agent';

export const isAiPath = (pathname: string | null) => !!pathname && pathname.startsWith(AI_ROUTE);
