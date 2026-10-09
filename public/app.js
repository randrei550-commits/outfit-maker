// funcție care cere hainele de la server și le pune pe pagină
async function incarcaHaine() {
  const raspuns = await fetch("/api/haine"); // îl chemăm pe ospătar
  const haine = await raspuns.json();        // despachetăm vectorul

  const lista = document.getElementById("lista-haine"); // găsim lista goală

  for (const haina of haine) {                    // ca un for în C, dar direct pe elemente
    const element = document.createElement("li"); // creăm un rând nou de listă
    element.textContent = haina.nume + " (" + haina.tip + ")";
    lista.appendChild(element);                   // îl lipim în listă
  }
}

incarcaHaine(); // pornim funcția când se încarcă pagina