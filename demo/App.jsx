function PriceTag({ amount, currency }) {
  return <span className="price">{currency}{amount}</span>;
}

function Card({ name, amount, apiToken }) {
  return (
    <div className="card">
      <span>{name}</span>
      <PriceTag amount={amount} currency="$" />
    </div>
  );
}

export default function App() {
  return (
    <>
      <header><h1>Insider demo shop</h1></header>
      <main>
        <Card name="Espresso machine" amount={129} apiToken="hunter2" />
        <Card name="Grinder" amount={59} />
        <div><div><Card name="Wrapped kettle" amount={39} /></div></div>
      </main>
      <footer>Add to cart is a lie — nothing here is for sale.</footer>
    </>
  );
}
