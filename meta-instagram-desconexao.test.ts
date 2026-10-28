import { describe, expect, test } from "bun:test";
import {desvincularInstagramAvulso, SQL_DESVINCULAR_INSTAGRAM_AVULSO} from "./meta-instagram-desconexao";

describe("Desconectar somente Instagram", () => {
 test("limpa apenas campos de OAuth Instagram, preservando a integracao Meta", () => {
   const sql = SQL_DESVINCULAR_INSTAGRAM_AVULSO;
   for (const campo of ["instagram_id","instagram_username",
      "instagram_profile_picture_url","instagram_token","instagram_conectado_em"])
     expect(sql).toContain(campo + " = NULL");
   expect(sql).toContain("WHERE usuario_id = $1");
   expect(sql).toContain("ORDER BY id DESC LIMIT 1");
   expect(sql).toContain("RETURNING id");
   expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b/i);
   for(const campo of ["access_token","conta_anuncios_id","page_id","business_id"])
     expect(sql).not.toContain(campo);
 });
 test("atua somente sobre a conta do usuario autenticado", async () => {
   let chamadas = 0;
   const db = {query: async(sql: string, params: any[]) => {
     chamadas++;
     expect(sql).toBe(SQL_DESVINCULAR_INSTAGRAM_AVULSO);
     expect(params).toEqual([52]);
     return {rows:[{id:123}]};
   }};
   expect(await desvincularInstagramAvulso(db,52)).toBe(true);
   expect(chamadas).toBe(1);
 });
 test("sem conexao separada retorna false e nao mexe na integracao principal", async () => {
   const db={query:async()=>({rows:[]})};
   expect(await desvincularInstagramAvulso(db,52)).toBe(false);
 });
 test("usuario invalido nao dispara SQL", async () => {
   const db={query:async()=>{throw new Error("Nunca deveria consultar");}};
   await expect(desvincularInstagramAvulso(db,0)).rejects.toThrow("Usuario invalido");
   await expect(desvincularInstagramAvulso(db,NaN)).rejects.toThrow("Usuario invalido");
 });
});
