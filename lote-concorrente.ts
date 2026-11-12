// Executa uma tarefa assíncrona para cada item, no máximo `limite` ao mesmo tempo,
// e devolve os resultados na ordem dos itens. Usado nas consultas às redes de
// anúncios: uma a uma ficam lentas demais; todas juntas estouram o limite da API.
// Se `tarefa` lançar erro, o lote todo rejeita — trate o erro dentro da tarefa
// quando uma falha não deve derrubar as outras.
export async function mapearComLimite<T, R>(
  itens: readonly T[],
  limite: number,
  tarefa: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(itens.length);
  const simultaneas = Math.max(1, Math.min(Math.floor(Number(limite)) || 1, itens.length));
  let proximo = 0;

  const trabalhador = async () => {
    while (proximo < itens.length) {
      const indice = proximo++;
      resultados[indice] = await tarefa(itens[indice], indice);
    }
  };

  await Promise.all(Array.from({ length: simultaneas }, trabalhador));
  return resultados;
}
