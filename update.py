import os
import subprocess

REPOSITORIOS = [
    {
        "nome": "Frontend",
        "caminho": r"C:\Users\perei\Projeto-Leads"
    },
    {
        "nome": "Backend",
        "caminho": r"C:\Users\perei\Projeto-Leads-Backend"
    }
]

mensagem_commit = input("Mensagem do commit: ").strip()

if not mensagem_commit:
    mensagem_commit = "update projeto"

for repo in REPOSITORIOS:

    print(f"\n🚀 Atualizando {repo['nome']}")

    os.chdir(repo["caminho"])

    comandos = [
        "git add .",
        f'git commit -m "{mensagem_commit}"',
        "git push"
    ]

    for comando in comandos:

        print(f"\n➡ Executando: {comando}")

        resultado = subprocess.run(
            comando,
            shell=True,
            text=True
        )

        if resultado.returncode != 0:
            print(f"❌ Erro ao executar: {comando}")

print("\n✅ Processo finalizado.")