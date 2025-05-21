require("dotenv").config();
const express = require("express");
var jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 5000;
const axios = require("axios");

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://jobspark-sourav246.netlify.app",
      "https://jobspark-sourav246.web.app",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  })
);
app.use(express.json());
app.use(cookieParser());

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
};

const verifyToken = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).send({ message: "Unauthorized: Token not found" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: "Unauthorized: Invalid token" });
    }
    req.user = decoded;
    next();
  });
};

function calculateProfileProgress(profile) {
  let progress = 0;

  if (profile.headline) progress += 10;
  if (profile.bio) progress += 10;
  if (profile.location) progress += 10;
  if (profile.skills?.length > 0) progress += 10;
  if (profile.experience?.length > 0) progress += 10;
  if (profile.education?.length > 0) progress += 10;
  if (profile.jobPreferences?.jobTypes?.length > 0) progress += 10;
  if (profile.jobPreferences?.locations?.length > 0) progress += 10;
  if (
    profile.jobPreferences?.salary?.min &&
    profile.jobPreferences?.salary?.max
  )
    progress += 10;
  if (profile.careerInfo?.length > 0) progress += 5;
  if (profile.projects?.length > 0) progress += 5;

  return Math.min(progress, 100); // Ensure max 100
}

const prepareRecommendationsData = async (
  email,
  userCollection,
  jobCollection
) => {
  try {
    // Fetch user by email
    const user = await userCollection.findOne({ email });
    if (!user) {
      throw new Error("User not found");
    }

    // Fetch recent jobs (limit to 20)
    const jobs = await jobCollection.find().limit(20).toArray();

    // Format user profile for AI analysis
    const userProfile = {
      name: user.name || "N/A",
      headline: user.profile?.headline || "",
      skills: user.profile?.skills || [],
      experience: user.profile?.experience || [],
      education: user.profile?.education || [],
      jobPreferences: user.profile?.jobPreferences || {
        jobTypes: [],
        locations: [],
        salary: { min: null, max: null },
        remote: null,
      },
    };

    // Create prompt for OpenAI
    const prompt = `
    I have a job seeker with the following profile:
    Name: ${userProfile.name}
    Headline: ${userProfile.headline}
    Skills: ${userProfile.skills.join(", ") || "None"}
    Experience: ${
      userProfile.experience.length > 0
        ? userProfile.experience
            .map(
              (exp) =>
                `${exp.title} at ${exp.company} (${exp.duration || "N/A"})`
            )
            .join("; ")
        : "None"
    }
    Education: ${
      userProfile.education.length > 0
        ? userProfile.education
            .map(
              (edu) =>
                `${edu.degree} at ${edu.institution} (${edu.year || "N/A"})`
            )
            .join("; ")
        : "None"
    }
    Job Preferences: 
      Job Types: ${userProfile.jobPreferences.jobTypes.join(", ") || "N/A"}
      Locations: ${userProfile.jobPreferences.locations.join(", ") || "N/A"}
      Salary Range: ${userProfile.jobPreferences.salary.min || "N/A"} - ${
        userProfile.jobPreferences.salary.max || "N/A"
      }
      Remote: ${userProfile.jobPreferences.remote ? "Yes" : "No"}
    
    And these job listings:
    ${
      jobs.length > 0
        ? jobs
            .map(
              (job) =>
                `Job ID: ${job._id}
         Title: ${job.title}
         Company: ${job.company}
         Location: ${job.location || "N/A"}
         Job Type: ${job.jobType || "N/A"}
         Salary Range: ${job.salaryRange || "N/A"}
         Required Skills: ${(job.skills || []).join(", ") || "None"}
         Description: ${job.description}`
            )
            .join("\n\n")
        : "No jobs available"
    }
    
    Analyze the user's profile and job listings to find the top 3 matches. 
    Return **only** a JSON object with an array of matches, where each match contains:
    - job_id (string): The job ID
    - match_score (number): A score from 0 to 100
    
    Example response format:
    {
      "matches": [
        { "job_id": "example_id_1", "match_score": 80 },
        { "job_id": "example_id_2", "match_score": 70 },
        { "job_id": "example_id_3", "match_score": 60 }
      ]
    }
    
    Do not include any additional text, explanations, or comments outside the JSON object.
  `;
    return { userProfile, jobs, prompt };
  } catch (error) {
    throw new Error(error.message || "Failed to prepare recommendations data");
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_KEY}@cluster0.pb8np.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("JobSpark");
    const userCollection = db.collection("users");
    const jobCollection = db.collection("Jobs");

    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, `${process.env.JWT_SECRET}`, {
        expiresIn: "1h",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: false,
        })
        .send({ success: true });
    });

    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: false,
      });
      res.status(200).send({
        success: true,
      });
    });

    // user api here
    app.post("/user", async (req, res) => {
      try {
        const { displayName, email, dbPhoto } = req.body;

        if (!email || !displayName || !dbPhoto) {
          return res
            .status(400)
            .send({ message: "Email and Display Name are required." });
        }

        const existingUser = await userCollection.findOne({ email });
        if (existingUser) {
          return res
            .status(201)
            .send({ message: "User already exists with this email." });
        }

        const newUser = {
          name: displayName,
          email,
          dbPhoto: dbPhoto,
          avatar: dbPhoto || "",
          profile: {
            headline: null,
            bio: null,
            location: null,
            skills: [],
            experience: [],
            education: [],
            jobPreferences: {
              jobTypes: [],
              locations: [],
              salary: {
                min: null,
                max: null,
              },
              remote: null,
            },
          },
          applicationStats: {
            applied: 0,
            inProgress: 0,
            interviews: 0,
            offers: 0,
            rejected: 0,
          },
          applications: [],
          offers: [],
          Interviews: [],
          role: "user",
          progress: 10,
        };

        const result = await userCollection.insertOne(newUser);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    app.get("/users", async (req, res) => {
      try {
        const users = userCollection.find();
        const collections = await users.toArray();
        res.send(collections);
      } catch (error) {
        res.status(201).send("internal server error!");
      }
    });

    app.get("/user/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await userCollection.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found" });
        res.json(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).json({ message: "Internal server error!" });
      }
    });

    //update user profile
    app.patch("/user/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const { profile } = req.body;

      if (!email || !profile) {
        return res
          .status(400)
          .json({ success: false, message: "Email or profile data missing." });
      }

      const progress = calculateProfileProgress(profile);
      try {
        const result = await userCollection.updateOne(
          { email: email },
          { $set: { profile: profile, progress: progress } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "User not found." });
        }
        const user = await userCollection.findOne({ email });

        res.send({ success: true, message: "Profile updated", result, user });
      } catch (error) {
        console.error("Error updating user:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal server error" });
      }
    });

    app.patch("/user/:email/apply", async (req, res) => {
      const email = req.params.email;
      const newApplication = req.body;

      if (!email || !newApplication) {
        return res.status(400).json({
          success: false,
          message: "Missing email or application data.",
        });
      }

      try {
        const user = await userCollection.findOne({ email });

        if (!user) {
          return res
            .status(404)
            .json({ success: false, message: "User not found." });
        }

        // Add new application
        const result = await userCollection.updateOne(
          { email },
          {
            $push: { applications: newApplication },
            $inc: {
              "applicationStats.applied": 1,
              "applicationStats.inProgress": 1,
            },
          }
        );

        res.send({
          success: true,
          message: "Application submitted successfully.",
          result,
        });
      } catch (error) {
        console.error("Error submitting application:", error);
        res.status(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    });

    //Job Data api
    app.get("/jobs", async (req, res) => {
      try {
        const users = jobCollection.find();
        const jobs = await users.toArray();
        res.send(jobs);
      } catch (error) {
        res.status(201).send("internal server error!");
      }
    });

    // hugging face ai recommendation route
    app.get("/recommendations", async (req, res) => {
      try {
        const email = req.query.email;
        // console.log("Fetching recommendations for email:", email);
        const { prompt } = await prepareRecommendationsData(
          email,
          userCollection,
          jobCollection
        );

        // Call Hugging Face Inference API
        const response = await axios.post(
          "https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-Instruct-v0.1",
          {
            inputs: prompt,
            parameters: {
              max_new_tokens: 1000,
              temperature: 0.3,
              return_full_text: false,
              use_cache: true,
            },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        // Log the raw response

        // Parse the AI response
        let aiResponse;
        try {
          const generatedText = response.data[0].generated_text;
          // Extract JSON by matching content within curly braces
          const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            aiResponse = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error("No valid JSON found in response");
          }
        } catch (parseError) {
          console.error("Parse error:", parseError.message);
          console.error("Raw response text:", response.data[0].generated_text);
          return res
            .status(500)
            .json({ message: "Failed to parse AI response" });
        }

        // Validate and convert job IDs
        const recommendedJobIds = aiResponse.matches
          .filter((match) => {
            try {
              ObjectId.createFromHexString(match.job_id);
              return true;
            } catch (e) {
              console.error(`Invalid ObjectId: ${match.job_id}`);
              return false;
            }
          })
          .map((match) => ObjectId.createFromHexString(match.job_id));

        // Fetch job details
        const recommendedJobs = await jobCollection
          .find({ _id: { $in: recommendedJobIds } })
          .toArray();

        // Log if no jobs are found
        if (recommendedJobs.length === 0) {
          console.warn("No matching jobs found for IDs:", recommendedJobIds);
        }

        // Combine AI recommendations with job details
        const recommendations = aiResponse.matches
          .map((match) => {
            const jobDetails = recommendedJobs.find(
              (job) => job._id.toString() === match.job_id
            );
            return {
              ...match,
              jobDetails,
            };
          })
          .filter((rec) => rec.jobDetails); // Filter out null jobDetails

        // Fallback if no valid recommendations
        if (recommendations.length === 0) {
          console.warn("No valid recommendations, returning recent jobs");
          const fallbackJobs = await jobCollection.find().limit(3).toArray();
          const fallbackRecommendations = fallbackJobs.map((job) => ({
            job_id: job._id.toString(),
            match_score: 50,
            jobDetails: job,
          }));
          return res.json(fallbackRecommendations);
        }

        // console.log("Recommendations:", recommendations);
        res.json(recommendations);
      } catch (error) {
        console.error("Error details:", error);
        if (error.response) {
          console.error(
            "Hugging Face API error response:",
            error.response.data
          );
        }
        if (error.response?.status === 429) {
          res
            .status(429)
            .json({ message: "Rate limit exceeded. Please try again later." });
        } else {
          res
            .status(500)
            .json({ message: "Failed to generate recommendations" });
        }
      }
    });
    console.log("Connected to MongoDB successfully!");
  } catch (err) {
    console.error(err);
    await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("JobSpark server is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
