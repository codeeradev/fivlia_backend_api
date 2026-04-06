const type = require("../modals/type");

// exports.addType = async (req, res) => {
//   try {
//     const { name, description } = req.body;
//     const imagePath = req.file ? req.file.filename : null;

//     if (!name || !description || !imagePath) {
//       return res
//         .status(400)
//         .json({ message: "Name, description and image are required" });
//     }

//     const newType = new type({
//       name,
//       description,
//       image: imagePath,
//     });

//     await newType.save();
//     res.status(201).json({ message: "Type created successfully", type: newType });
//   } catch (error) {
//     console.error("Error creating type:", error);
//     res.status(500).json({ message: "Internal server error" });
//   }
// };

exports.getTypes = async (req, res) => {
  try {
    const types = await type.find();
    res.status(200).json(types);
  } catch (error) {
    console.error("Error fetching types:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};