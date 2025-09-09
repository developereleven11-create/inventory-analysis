export default function handler(req,res){
  // realistic sample data with small series for sparklines
  res.status(200).json({
    "skus":[
      {"sku":"POK-234","title":"Baby Oil 200ml","current_stock":42,"avg_daily_30":5.5,"days_of_cover":7.6,"mtd":100,"prev_mtd":60,"trend":"fast","series":[2,3,4,6,7,9,10]},
      {"sku":"POK-789","title":"Mother Cream 100g","current_stock":180,"avg_daily_30":4.0,"days_of_cover":45,"mtd":60,"prev_mtd":120,"trend":"slow","series":[6,5,4,3,2,2,1]},
      {"sku":"POK-512","title":"Gentle Cleanser","current_stock":12,"avg_daily_30":2.0,"days_of_cover":6,"mtd":40,"prev_mtd":30,"trend":"steady","series":[1,2,1,2,3,2,2]},
      {"sku":"POK-998","title":"Baby Wipes Pack","current_stock":300,"avg_daily_30":10,"days_of_cover":30,"mtd":350,"prev_mtd":180,"trend":"fast","series":[20,22,25,28,30,32,35]}
    ]
  });
}
