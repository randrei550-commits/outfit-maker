// funcție care cere hainele de la server și le pune pe pagină
async function incarcaHaine() {
  const raspuns = await fetch("/api/haine"); // îl chemăm pe ospătar
  const haine = await raspuns.json();        // despachetăm vectorul

  const lista = document.getElementById("lista-haine"); // găsim lista goală

    for (const haina of haine) {
    const card = document.createElement("li");   // cardul e tot un rând de listă
    card.className = "card";                      // „eticheta” după care îl stilizăm în CSS

    const titlu = document.createElement("h2");
    titlu.textContent = haina.nume;

    const tip = document.createElement("p");
    tip.className = "tip";
    tip.textContent = haina.tip;

    const pastile = document.createElement("ul"); // o listă mică în card, pentru stiluri
    pastile.className = "pastile";
    for (const stil of haina.stiluri) {           // un for în alt for, ca în C
      const pastila = document.createElement("li");
      pastila.className = "pastila";
      pastila.textContent = stil;
      pastile.appendChild(pastila);
    }

    card.append(titlu, tip, pastile);             // punem cele trei bucăți în card
    lista.appendChild(card);                      // și cardul în listă
  }
}

incarcaHaine(); // pornim funcția când se încarcă pagina