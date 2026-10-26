import type { QualityAdapter,QualityPack,QualityReport,QualityResult,QualityCase } from '../../src/shared/quality'
export function digest(value:unknown):string
export function runQuality(input:{pack:QualityPack;models:string[];repeats?:number;maxCalls:number;maxOutputTokens:number;timeoutMs?:number;adapter:QualityAdapter;live?:boolean;adjudications?:Record<string,unknown>}):Promise<QualityReport>
export function adjudicateReport(report:QualityReport,pack:QualityPack,decisions:Record<string,unknown>):QualityReport
export function assessQuality(test:QualityCase,result:QualityResult,decision?:unknown):{state:string}
