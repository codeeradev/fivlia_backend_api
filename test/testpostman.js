CATEGORY IDs:
69cf8a3fad92aee54ecb1e74 (groceryTypeId)

69cf8a4bad92aee54ecb1e76 (mallTypeId)

http://127.0.0.1:8080

Sub-Category Ids:
add new category id for global store: 683eed3ff6f5264ba0295767 (Sports & Fitness)
old category id: 683eebc7f6f5264ba0295761 (Groceries)


Outside zone:
 "latitude": 30.901,
"longitude": 75.8573

Collection: {
  "fullName": "Rahul",
  "alternateNumber": "9813925952",
  "pincode": "141001",
  "house_No": "12",
  "address": "Model Town, Ludhiana",
  "state": "Punjab",
  "city": "Ludhiana",
  "latitude": "{{outLat}}",
  "longitude": "{{outLng}}",
  "addressType": "home",
  "floor": "1",
  "landmark": "Near park",
  "range": 100
}


Inside zone:
lat: 29.151861
lng: 75.721123
{
  "fullName": "Rahul",
  "alternateNumber": "9813925952",
  "pincode": "125001",
  "house_No": "12",
  "address": "Model Town, Hisar",
  "state": "Haryana",
  "city": "Hisar",
  "latitude": "{{inLat}}",
  "longitude": "{{inLng}}",
  "addressType": "home",
  "floor": "1",
  "landmark": "Near park",
  "range": 100
}

Store login creditionals:
email: globalstore@test.com
pass: Test@1234

--------------   PROBLEM   -------------------


Now all set, i need to update the all products api is not show the products for the global store if 
product are out of stock, 
do not make change for local zone based store products, it is similar there is no chnage it is live cosde