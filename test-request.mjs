const payload = {
  merchantId: "031bbca1-dc54-4a35-82c3-368db67f9e33",
  amount: 1000
};

const response = await fetch("http://localhost:3000/api/payment-intents", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

console.log("Status:", response.status);
console.log("Response:", await response.text());
